var shimmer = require('../../util/shimmer.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.stompit');
var recorder = require('../../metrics/recorders/mq.js')('ActiveMQ');
var common = require('../common');
var util = require('../../util/util');
var fmt = require('util').format;
var recordWeb = require('../../metrics/recorders/http.js');

module.exports = function initialize(agent, stompit) {
    if (!stompit) {
        return logger.verbose("stompit does not exists.");
    }
    if (!stompit.Client) {
        return logger.verbose("stompit.Client does not exists.");
    }

    var tracer = agent.tracer;

    shimmer.wrapMethodOnce(stompit.Client.prototype, 'stompit.Client.prototype', 'send', function(send) {
        return tracer.segmentProxy(function(headers) {
            if (!agent.enabled()) {
                logger.debug('agent disabled.');
                return send.apply(this, arguments);
            }
            if (!agent.getAction()) {
                logger.debug('can not get action.');
                return send.apply(this, arguments);
            }

            if (util.isString(headers)) {
                headers = {
                    destination: headers
                };
            }

            var tingyunId = common.getTingyunId(agent, 'mq');
            if (tingyunId) {
                headers['TingyunID'] = tingyunId;
            }

            var frame = send.apply(this, arguments);
            var segment;
            shimmer.wrapMethod(frame, 'frame.write', 'write', function(write) {
                return function(data) {
                    var destination = this.headers && this.headers.destination;
                    if (!destination) {
                        logger.debug('header does not have destination property.');
                        return write.apply(this, arguments);
                    }
                    if (segment) {
                        segment.mq.size += data && Buffer.byteLength(data) || 0;
                    } else {
                        var model = extractModel(destination);
                        segment = tracer.addSegment({
                            metric_name: model.name || 'Temp',
                            call_url: "",
                            call_count: 1,
                            class_name: "Frame",
                            method_name: 'write',
                            params: {}
                        }, recorder);

                        var mq = segment.mq = {};
                        mq.type = model.type;
                        mq.opType = 'Produce';
                        mq.size = mq.size || 0;
                        mq.size += data && Buffer.byteLength(data) || 0;

                        segment.host = this._stream._destination.remoteAddress;
                        segment.port = this._stream._destination.remotePort;

                        if (tingyunId) {
                            segment.parameters.externalId = common.findInTingyunId(tingyunId, 'e=');
                        }
                    }
                    return write.apply(this, arguments);
                };
            });

            shimmer.wrapMethod(frame, 'frame.end', 'end', function(end) {
                return function(data) {
                    if (segment && segment.mq) {
                        if (data) {
                            segment.mq.size = (segment.mq.size || 0) + Buffer.byteLength(data);
                        }
                        segment.end();
                    }
                    return end.apply(this, arguments);
                };
            });

            return frame;
        });
    });

    shimmer.wrapMethodOnce(stompit.Client.prototype, 'stompit.Client.prototype', 'subscribe', function(subscribe) {
        return function(headers, messageListener) {
            logger.debug('treat consumer as server side.');
            if (!util.isFunction(messageListener)) {
                logger.debug('messageListener is not a function when calling subscribe in activemq server.');
                return subscribe.apply(this, arguments);
            }

            var host = this._transportSocket.remoteAddress;
            var port = this._transportSocket.remotePort;

            var listener = function(error, message) {
                if (!agent.config.mq.enabled) {
                    logger.debug('nbs.mq.enabled disabled');
                    return messageListener.apply(this, arguments);
                }
                if (agent.getAction()) {
                    logger.debug('got action, invoking inside an http request.');
                    return messageListener.apply(this, arguments);;
                }

                shimmer.wrapMethod(message, 'stompit.Client.prototype', 'readString', function(readString) {
                    return tracer.actionProxy(function() {
                        var action = tracer.getAction();
                        if (!action) {
                            logger.debug('create action failed.');
                            return readString.apply(this, arguments);
                        }
                        var args = Array.prototype.slice.call(arguments, 0);
                        var callback = args[1];
                        if (!util.isFunction(callback)) {
                            logger.debug('arguments type invalid, no callback function.');
                            return readString.apply(this, arguments);
                        }

                        var headers = this.headers;
                        if (!headers) {
                            logger.debug('can not get headers.');
                            return readString.apply(this, arguments);
                        }
                        var destination = headers.destination;
                        if (!destination) {
                            logger.debug('destination does not exist.');
                            return readString.apply(this, arguments);
                        }
                        var model = extractModel(destination);
                        var type = model.type;
                        destination = model.name;

                        var url = fmt('%s/%s/%s', 'ActiveMQ', type, destination);
                        var segmentInfo = {
                            metric_name: "NodeJS/NULL/" + url,
                            call_url: "",
                            call_count: 1,
                            class_name: 'Client',
                            method_name: 'subscribe',
                            params: {}
                        };
                        var segment = tracer.addSegment(segmentInfo, recordWeb);
                        action.url = url;
                        if (!action.partialName) {
                            action.setPartialName(url);
                        }
                        action.name = "WebAction/" + action.partialName;
                        segment.partialName = action.partialName;
                        action.statusCode = 200;

                        var activeSegment = tracer.addSegment({
                            metric_name: destination || 'Temp',
                            call_url: "",
                            call_count: 1,
                            class_name: "IncomingMessage",
                            method_name: 'readString',
                            params: {}
                        }, recorder);

                        var mq = activeSegment.mq = {};
                        mq.type = type;

                        var custom = action.setCustom(headers, action.statusCode);
                        activeSegment.opType = 'Consume';
                        activeSegment.host = host;
                        activeSegment.port = port;
                        if (activeSegment.host) {
                            custom['message.MachineName'] = activeSegment.host + ':' + activeSegment.port;
                        }

                        var tingyunId = headers['TingyunID'];
                        if (tingyunId) {
                            var start = common.findInTingyunId(tingyunId, 's=');
                            if (start) {
                                mq.wait = custom['message.wait'] = new Date().getTime() - parseInt(start);
                            }
                            action.trans = {
                                app_id: tingyunId
                            };
                            action.trans.trans_id = common.findInTingyunId(tingyunId, 'x=');
                        }

                        custom['message.queue'] = destination;

                        var config = agent.config;
                        if (config.capture_params && headers) {
                            var trace = action.getTrace();
                            var ignoreParams = config.ignored_params && Array.isArray(config.ignored_params) ? config.ignored_params : [];
                            ignoreParams.push('TingyunID');
                            var headerKeys = Object.keys(headers);
                            headerKeys.forEach(function(key) {
                                if (ignoreParams.indexOf(key) < 0) {
                                    trace.parameters['headers.' + key] = headers[key];
                                }
                            });
                        }

                        segment.markAsWeb(url);

                        args[1] = function(error, body) {
                            if (error) {
                                catchError(error);
                            }
                            mq.size = body && Buffer.byteLength(body) || 0;
                            custom['message.byte'] = mq.size;
                            try {
                                var result = callback.apply(this, arguments);
                            } catch (e) {
                                catchError(e);
                                action.statusCode = 500;
                                segment.end();
                                activeSegment.end();
                                custom.entryTrace = getEntryTrace();
                                action.end();
                                throw e;
                            }
                            segment.end();
                            activeSegment.end();
                            custom.entryTrace = getEntryTrace();
                            action.end();
                            return result;
                        }

                        return readString.apply(this, args);

                        function getEntryTrace() {
                            if (!tingyunId) {
                                return null;
                            }
                            var timeObj;
                            try {
                                timeObj = JSON.parse(action.getTraceDurations());
                            } catch (e) {
                                logger.error('error when parse action trace data');
                                timeObj = {};
                            }
                            return {
                                "applicationId": common.getApplicationId(config.transaction_tracer.tingyunIdSecret),
                                "transactionId": common.findInTingyunId(tingyunId, 'x=') || '',
                                "externalId": common.findInTingyunId(tingyunId, 'e=') || '',
                                "time": timeObj.time || {}
                            };
                        }
                    });
                });
                return messageListener.apply(this, arguments);
            };

            return subscribe.call(this, headers, listener);
        }
    });
};

function catchError(action, error) {
    var action = agent.getAction();
    if (action) {
        action.addExceptions(error);
    } else {
        logger.error('stompit error, but no action context!', error);
    }
}

function equalIgnoreCase(a, b) {
    return a && b && a.toLowerCase() === b.toLowerCase();
}

function extractModel(destination) {
    destination = destination.split(/\//);
    if (destination[0] == '') {
        destination.shift();
    }
    var type = equalIgnoreCase(destination[0], 'topic') ? 'Topic' : 'Queue';
    destination.shift();
    return {
        type: type,
        name: destination.join('%2F')
    };
}