'use strict';

var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.cassandra-driver');
var record = require('../../metrics/recorders/cache_storage.js')('Cassandra');
var generalRecord = require('../../metrics/recorders/generic.js');
var parseSql = require('../db/parse-sql');
var util = require('../../util/util');
var confuse = require('../../ext/ext_main').confusion;
var CallStack = require('../../util/stack');

module.exports = function(agent, cassandra) {
    var proto;
    if (!agent.enabled()) {
        return logger.verbose("agent disabled.");
    }
    if (!cassandra || !(cassandra.Client && (proto = cassandra.Client.prototype))) {
        return logger.verbose("cassandra.Client or its prototype does not exist.");
    }

    var tracer = agent.tracer;

    shimmer.wrapMethod(proto, 'cassandra.Client.prototype', 'connect', function wrapper(connect) {
        return tracer.segmentProxy(function(callback) {
            var listeners = this.listeners('hostDown');
            if (!listeners.length || !listeners.some(function(listener) {
                    return !!listener.hostDown;
                })) {
                var listener = function(host) {
                    var error = new Error('Host (' + host.address + ') is down at ' + new Date().toString());
                    var action = agent.getAction();
                    if (action) {
                        if (segment) {
                            addSegmentException(segment, error);
                        }
                        action.addExceptions(error);
                    } else {
                        logger.error('host down error, but no action context!', error);
                    }
                };
                listener.hostDown = true;
                this.on('hostDown', listener);
            }
            if (!tracer.getSegment()) {
                logger.debug('connect method is called outside a http request, skip it.');
                return connect.apply(this, arguments);
            }
            var segmentInfo = {
                metric_name: 'Cassandra/NULL/connect',
                call_url: "",
                call_count: 1,
                class_name: 'cassandra.Client',
                method_name: 'connect',
                params: {}
            };
            var segment = tracer.addSegment(segmentInfo, generalRecord);
            var cb = function(error) {
                if (error instanceof Error) {
                    var action = agent.getAction();
                    if (action) {
                        addSegmentException(segment, error);
                        action.addExceptions(error);
                    } else {
                        logger.error('cassandra connect error, but no action context!', error);
                    }
                }
                segment.end();
                return callback.apply(this, arguments);
            };
            return connect.call(this, cb);
        });
    });

    shimmer.wrapMethod(proto, 'cassandra.Client.prototype', 'execute', wrapper('execute'));
    shimmer.wrapMethod(proto, 'cassandra.Client.prototype', 'stream', wrapper('stream'));

    function wrapper(method) {
        return function(execute) {
            return tracer.segmentProxy(function(query) {
                var action;
                if (!agent.enabled() || !(action = tracer.getAction())) {
                    return execute.apply(this, arguments);
                }
                var args = arguments;
                var length = args.length - 1;
                var cb = args[length];
                if (!util.isString(query) || !util.isFunction(cb)) {
                    logger.debug('cassandra.client[%s]: parameters do not match, skip monitoring.', method);
                    return execute.apply(this, arguments);
                }
                if (!tracer.getSegment()) {
                    logger.debug('%s method is called outside a http request, skip it.', method);
                    return execute.apply(this, arguments);
                }
                var ps = parseSql("Database cassandra", query);
                var metricsName = ps && ps.metricName() || 'Cassandra/NULL/' + method;
                var segmentInfo = {
                    metric_name: metricsName,
                    call_url: "",
                    call_count: 1,
                    class_name: 'cassandra.Client',
                    method_name: method,
                    params: {}
                };
                var segment = tracer.addSegment(segmentInfo, record);

                setHost(segment, this.controlConnection && this.controlConnection.host && this.controlConnection.host.address);

                args[length] = tracer.callbackProxy(function() {
                    var result = cb.apply(this, arguments);
                    var config = agent.config;
                    if (config.action_tracer.slow_sql === true) {
                        segment.parameters.sql = getSql(config, query);
                        segment.end(config, {
                            sql: query,
                            stack: CallStack("cassandra.Client." + method, 2)
                        });
                    } else {
                        segment.end();
                    }
                    return result;
                });
                return execute.apply(this, args);
            });
        }
    }

    shimmer.wrapMethod(proto, 'cassandra.Client.prototype', 'shutdown', function wrapper(shutdown) {
        return tracer.segmentProxy(function(callback) {
            var segmentInfo = {
                metric_name: 'Cassandra/NULL/shutdown',
                call_url: "",
                call_count: 1,
                class_name: 'cassandra.Client',
                method_name: 'shutdown',
                params: {}
            };
            if (!tracer.getSegment()) {
                logger.debug('shutdown method is called outside a http request, skip it.');
                return shutdown.apply(this, arguments);
            }
            var segment = tracer.addSegment(segmentInfo, generalRecord);
            var cb = function(error) {
                if (error instanceof Error) {
                    var action = agent.getAction();
                    if (action) {
                        addSegmentException(segment, error);
                        action.addExceptions(error);
                    } else {
                        logger.error('cassandra shutdown error, but no action context!', error);
                    }
                }
                segment.end();
                if (callback) {
                    return callback.apply(this, arguments);
                }
                return undefined;
            };
            return shutdown.call(this, cb);
        });
    });
};

function addSegmentException(segment, error) {
    var exceptions = segment.parameters.exception = segment.parameters.exception || [];
    exceptions.push({
        message: error.message,
        class: util.getErrorClassName(error),
        stacktrace: error.stack && error.stack.split('\n')
    });
}

function getSql(config, query) {
    var sqlConfusion = config.action_tracer.record_sql;
    if (sqlConfusion === 'obfuscated') {
        return confuse(query);
    } else if (sqlConfusion === 'raw') {
        return query;
    }
    return null;
}

function setHost(segment, address) {
    if (!address || typeof address !== 'string') {
        return;
    }
    address = address.split(':');
    segment.host = address[0];
    segment.port = parseInt(address[1] || 0);
}