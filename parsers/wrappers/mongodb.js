'use strict';

var ParsedStatement = require('../db/parsed-statement');
var shimmer = require('../../util/shimmer');
var urltils = require('../../util/urltils');
var logger = require('../../util/logger').child('parsers.wrappers.mongodb');

var COLLECTION_OPERATIONS = [
    'findOne',
    'insert',
    'remove',
    'save',
    'update',
    'distinct',
    'count',
    'findAndModify',
    'findAndRemove',
    'createIndex',
    'ensureIndex',
    'dropIndex',
    'dropAllIndexes',
    'reIndex'
];

var MONGO_RE = new RegExp('^MongoDB');

function isCurrentSegmentMongo(tracer) {
    var segment = tracer.getSegment();
    return MONGO_RE.test(segment.name);
}

var CURSOR_RE = new RegExp('^MongoDB.*/find$');

function isCurrentSegmentCursorOp(tracer) {
    var segment = tracer.getSegment();
    return CURSOR_RE.test(segment.name);
}

var COLLECTION_RE = new RegExp('^MongoDB(?!.*\/find$)');

function isCurrentSegmentCollectionOp(tracer) {
    var segment = tracer.getSegment();
    return COLLECTION_RE.test(segment.name);
}

function isCurrentSegmentInCallbackState(tracer) {
    return tracer.getSegment().isInCallbackState();
}

var cursorTracker = (function CursorTracker() {
    var activeCursors = {};
    var nextCursorId = 1;

    return {
        track: function track(cursor, segment) {
            if (!cursor.__TY_segment_id) {
                cursor.__TY_segment_id = nextCursorId++;
            }
            activeCursors[cursor.__TY_segment_id] = segment;
        },

        untrack: function untrack(cursor) {
            if (cursor.__TY_segment_id) {
                delete activeCursors[cursor.__TY_segment_id];
                delete cursor.__TY_segment_id;
            }
        },

        trackedSegment: function trackedSegment(cursor) {
            return cursor.__TY_segment_id && activeCursors[cursor.__TY_segment_id];
        }
    };
}());

function wrapCursorOperation(tracer, operationName) {
    if (operationName == 'close') {
        return function wp_close(close) {
            return function wrappedCursorClose() {
                var cursor = this;
                var segment = cursorTracker.trackedSegment(cursor);
                if (segment) {
                    cursorTracker.untrack(cursor);
                    segment.end();
                }
                return close.apply(this, arguments);
            };
        };
    }
    return function cls_wrapCursorOperation(operation) {
        return tracer.segmentProxy(function mongoCursorOperationProxy() {
            var cursor = this;
            var collection = (cursor.collection && cursor.collection.collectionName) || cursor.ns || 'unknown';
            var terms = cursor.selector;

            if (!tracer.getAction()) {
                logger.debug('no context in method %s', operationName);
                return operation.apply(this, arguments);
            }
            var args = tracer.slice(arguments);
            var last = args.length - 1;
            var callback = args[last];

            if (typeof callback !== 'function') {
                logger.debug('Not tracing MongoDB %s.%s(%j); last argument was not a callback.', collection, operationName, terms);
                return operation.apply(this, arguments);
            }
            var currentIsntMongo = !isCurrentSegmentMongo(tracer);
            var currentIsCollectionOperationInCallback = (isCurrentSegmentCollectionOp(tracer) && isCurrentSegmentInCallbackState(tracer));
            var currentIsCursorOperationAndThisCursorIsNew = (isCurrentSegmentCursorOp(tracer) && !cursorTracker.trackedSegment(cursor));

            if (currentIsntMongo || currentIsCollectionOperationInCallback || currentIsCursorOperationAndThisCursorIsNew) {
                addMongoStatement(tracer, collection, 'find', 'mongodb.Cursor', operationName);
                var segment = tracer.getSegment();
                cursorTracker.track(cursor, segment);

                var serverConfig;
                try {
                    serverConfig = this.topology.s.options;
                    segment.database = this.s.dbName || this.s.options.db.s.databaseName;
                } catch (e) {}
                if (serverConfig) {
                    segment.host = serverConfig.host;
                    segment.port = serverConfig.port;
                }
            }
            args[last] = tracer.callbackProxy(function cursorOperationCbProxy() {
                var ret = callback.apply(this, arguments);
                var segment = cursorTracker.trackedSegment(cursor);
                if (segment) {
                    segment.touch();
                }
                if (segment && (cursor.state === cursor.constructor.CLOSED || (cursor.s && cursor.s.state === cursor.constructor.CLOSED))) {
                    cursorTracker.untrack(cursor);
                    segment.end();
                }
                return ret;
            });

            return operation.apply(this, args);
        });
    }
}

function addMongoStatement(tracer, collection, operation, classname, methodname) {
    var statement = new ParsedStatement("MongoDB", operation, collection),
        recorder = statement.recordMetrics.bind(statement);
    var segment_info = {
        metric_name: statement.metricName(),
        call_url: "",
        call_count: 1,
        class_name: classname,
        method_name: methodname,
        params: {}
    };
    return tracer.addSegment(segment_info, recorder);
}

var CURSOR_METHODS = ['toArray', 'each', 'nextObject', 'close'];

module.exports = function initialize(agent, mongodb) {
    if (!(mongodb && mongodb.Collection && mongodb.Collection.prototype)) {
        return;
    }
    var tracer = agent.tracer;
    if (mongodb && mongodb.Cursor && mongodb.Cursor.prototype) {
        for (var i = 0; i < CURSOR_METHODS.length; i++) {
            shimmer.wrapMethod(mongodb.Cursor.prototype, 'mongodb.Cursor.prototype', CURSOR_METHODS[i], wrapCursorOperation(tracer, CURSOR_METHODS[i]));
        }
    }

    COLLECTION_OPERATIONS.forEach(function cb_forEach(operation) {
        shimmer.wrapMethod(mongodb.Collection.prototype, 'mongodb.Collection.prototype', operation, function cls(command) {
            return tracer.segmentProxy(function cb_segmentProxy() {
                var collection = this.collectionName || 'unknown';
                var args = tracer.slice(arguments);
                var terms = typeof args[0] === 'function' ? undefined : args[0];
                if (!tracer.getAction() || args.length < 1) {
                    return command.apply(this, arguments);
                }

                if (!isCurrentSegmentCollectionOp(tracer) || isCurrentSegmentInCallbackState(tracer)) {
                    var action = tracer.getAction();
                    var segment = addMongoStatement(tracer, collection, operation, 'mongodb.Collection', operation);
                    if (typeof terms === 'object') {
                        urltils.copyParameters(agent.config, terms, segment.parameters);
                    }

                    var serverConfig;
                    try {
                        segment.database = this.s.dbName;
                        serverConfig = this.s.topology.s;
                    } catch (e) {}

                    if (serverConfig) {
                        segment.host = serverConfig.host;
                        segment.port = serverConfig.port;
                    }

                    var callback = args.pop();
                    if (typeof callback !== 'function') {
                        args.push(callback);
                        args.push(tracer.callbackProxy(function cb_callbackProxy() {
                            segment.moveToCallbackState();
                            segment.end();
                        }));
                    } else {
                        args.push(tracer.callbackProxy(function cb_callbackProxy() {
                            segment.moveToCallbackState();
                            segment.end();
                            return callback.apply(this, arguments);
                        }));
                    }
                }
                return command.apply(this, args);
            });
        });
    });
};