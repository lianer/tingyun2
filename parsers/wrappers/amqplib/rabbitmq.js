var shimmer = require('../../../util/shimmer.js');
var logger = require('../../../util/logger.js').child('parsers.wrappers.amqplib.rabbitmq');
var recorder = require('../../../metrics/recorders/mq.js')('RabbitMQ');
var recordWeb = require('../../../metrics/recorders/http.js');
var util = require('../../../util/util.js');
var fmt = require('util').format;
var common = require('../../common');

exports.wrap = function(channel, channelType, agent) {
    var tracer = agent.tracer;
    shimmer.wrapMethod(channel, 'Channel.prototype', 'publish', function(publish) {
        return tracer.segmentProxy(function(exchange, routingKey, content, options, cb) {
            var args = Array.prototype.slice.call(arguments, 0);
            if (!tracer.getSegment()) {
                logger.debug('channel.publish method is called outside a http request.');
                return publish.apply(this, args);
            }
            var action = tracer.getAction();
            if (!action) {
                logger.debug('channel.publish is not under a correct context.');
                return publish.apply(this, args);
            }
            if (action.consumer) {
                logger.debug('skip wrap publish method inside consume method(as server side).');
                return publish.apply(this, args);
            }

            var segment = tracer.addSegment({
                metric_name: exchange || routingKey || 'Temp',
                call_url: "",
                call_count: 1,
                class_name: "Channel",
                method_name: 'publish',
                params: {}
            }, recorder);

            var mq = segment.mq = {};
            mq.type = exchange == '' ? 'Queue' : 'Exchange';
            mq.size = content && Buffer.byteLength(content) || 0;

            setAddress(this.connection, segment);

            var tingyunId = common.getTingyunId(agent, 'mq');
            if (tingyunId) {
                var opt = args[3] = args[3] || {};
                opt.headers = opt.headers || {};
                opt.headers['TingyunID'] = tingyunId;
                segment.parameters.externalId = common.findInTingyunId(tingyunId, 'e=');
            }

            var result = publish.apply(this, args);
            segment.end();
            return result;
        });
    });

    shimmer.wrapMethod(channel, 'Channel.prototype', 'consume', function(consume) {
        return function(queue, callback, options, cb0) {
            if (agent.getAction()) {
                logger.debug('got action, invoking inside an http request.');
                return consume.apply(this, arguments);
            }

            logger.debug('treat consumer as server side.');
            if (!util.isFunction(callback)) {
                logger.debug('callback is not a function when calling consume in rabbitmq server.');
                return consume.apply(this, arguments);
            }

            var self = this;

            var wrapped = tracer.actionProxy(function(msg) {
                if (!agent.config.mq.enabled) {
                    logger.debug('nbs.mq.enabled disabled');
                    return callback.apply(this, arguments);
                }
                var action = tracer.getAction();
                if (!action) {
                    return callback.apply(this, arguments);
                }
                action.consumer = true;

                var fields = msg.fields;
                var exchange = '';
                var routingKey = '';
                if (fields) {
                    exchange = fields.exchange;
                    routingKey = fields.routingKey;
                }
                var type = exchange ? 'Exchange' : 'Queue';

                var url = fmt('%s/%s/%s', 'RabbitMQ', type, exchange || routingKey);
                var segmentInfo = {
                    metric_name: "NodeJS/NULL/" + url,
                    call_url: "",
                    call_count: 1,
                    class_name: 'Channel',
                    method_name: 'consume',
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

                var rabbitSegment = tracer.addSegment({
                    metric_name: exchange || routingKey || 'Temp',
                    call_url: "",
                    call_count: 1,
                    class_name: "Channel",
                    method_name: 'consume',
                    params: {}
                }, recorder);

                var headers = msg.properties && msg.properties.headers;
                var custom = action.setCustom(headers || {}, action.statusCode);
                var size = msg.content && Buffer.byteLength(msg.content) || 0;
                custom['message.byte'] = size;

                var mq = rabbitSegment.mq = {};
                mq.size = size;
                mq.type = type;

                setAddress(self.connection, rabbitSegment);
                if (rabbitSegment.host) {
                    custom['message.MachineName'] = rabbitSegment.host + ':' + rabbitSegment.port;
                }

                var tingyunId;
                if (headers) {
                    tingyunId = headers['TingyunID'];
                    action.trans = {
                        app_id: tingyunId
                    };
                    action.trans.trans_id = common.findInTingyunId(tingyunId, 'x=');
                    var start = common.findInTingyunId(tingyunId, 's=');
                    if (start) {
                        mq.wait = custom['message.wait'] = new Date().getTime() - parseInt(start);
                    }
                } else {
                    logger.debug('properties.headers is null.');
                }

                custom['message.exchange'] = exchange;
                if (exchange) {
                    custom['message.routingkey'] = routingKey;
                } else {
                    custom['message.queue'] = routingKey;
                }

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

                var result;
                try {
                    result = callback.apply(this, arguments);
                } catch (e) {
                    logger.error('error when executing consume callback function', e);
                    action.setError(e)
                    action.statusCode = 500;
                    rabbitSegment.end();
                    segment.end();
                    custom.entryTrace = getEntryTrace();
                    action.end();
                    throw e;
                }
                rabbitSegment.end();
                segment.end();
                custom.entryTrace = getEntryTrace();
                action.end();
                return result;

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

            return consume.call(this, queue, wrapped, options, cb0);
        };
    });

    return channel;
};

function setAddress(connection, segment) {
    try {
        var socket = connection.stream;
        segment.host = socket.remoteAddress;
        segment.port = socket.remotePort;
    } catch (e) {
        logger.error("error when getting rabbitmq's address.", e);
    }
}

exports.handler = function(agent) {
    return function errorHanlder(error) {
        if (error) {
            var action = agent.getAction();
            if (action) {
                action.setError(error);
            } else {
                logger.error("error when create rabbit mq connection, but no action context!", error);
            }
        }
    }
};