var shimmer = require('../../util/shimmer.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.kafka-node');
var recorder = require('../../metrics/recorders/mq.js')('Kafka');
var util = require('../../util/util.js');
var fmt = require('util').format;
var url = require('url');
var common = require('../common');
var recordWeb = require('../../metrics/recorders/http.js');

module.exports = function initialize(agent, kafka) {
    if (!kafka || !kafka.Producer || !kafka.Producer.prototype) {
        return logger.verbose("kafka or kafka Producer does not exists.");
    }

    var tracer = agent.tracer;

    shimmer.wrapMethodOnce(kafka.Client.prototype, 'kafka.Client.prototype', 'connect', function(connect) {
        return function() {
            this.on('error', function(error) {
                var action = agent.getAction();
                if (action) {
                    action.addExceptions(error);
                } else {
                    logger.error('kafka connect error, but no action context!', error);
                }
            });
            return connect.apply(this, arguments);
        }
    });

    shimmer.wrapMethodOnce(kafka.Producer.prototype, 'kafka.Producer.prototype', 'send', wrapSend);
    shimmer.wrapMethodOnce(kafka.HighLevelProducer.prototype, 'kafka.HighLevelProducer.prototype', 'send', wrapSend);

    function wrapSend(send) {
        return tracer.segmentProxy(function(payloads) {
            if (!agent.enabled()) {
                logger.debug('agent disabled.');
                return send.apply(this, arguments);
            }
            if (!agent.getAction()) {
                logger.debug('can not get action.');
                return send.apply(this, arguments);
            }
            if (!Array.isArray(payloads)) {
                logger.debug('payloads type not matched.');
                return send.apply(this, arguments);
            }

            var tingyunId = common.getTingyunId(agent, 'mq');

            var segments = [];
            payloads.forEach(function(payload) {
                var sgInfo = {
                    metric_name: payload.topic,
                    call_url: "",
                    call_count: 1,
                    class_name: "Producer",
                    method_name: 'send',
                    params: {}
                };
                var sg = tracer.addSegment(sgInfo, recorder);
                if (tingyunId) {
                    sg.parameters.externalId = common.findInTingyunId(tingyunId, 'e=');
                }
                var mq = sg.mq = {};
                mq.type = 'Topic';
                mq.opType = 'Produce';
                mq.size = size(payload.messages);
                setAddress(sg, this.client && this.client.connectionString);
                segments.push(sg);
            }, this);
            var args = Array.prototype.slice.call(arguments, 0);
            var cbIndex = args.length - 1;
            var cb;
            if (util.isFunction((cb = args[cbIndex]))) {
                args[cbIndex] = function() {
                    segments.forEach(function(sg) {
                        sg.end();
                    });
                    return cb.apply(this, arguments);
                };
            } else {
                args.push(function() {
                    segments.forEach(function(sg) {
                        sg.end();
                    });
                });
            }
            return send.apply(this, args);
        });
    }

    function size(message) {
        var result = 0;
        if (!message) {
            return result;
        }
        if (util.isString(message) || message instanceof Buffer) {
            return Buffer.byteLength(message);
        }
        if (kafka.KeyedMessage && message instanceof kafka.KeyedMessage) {
            return size(message.key) + size(message.value);
        }
        if (Array.isArray(message)) {
            message.forEach(function(msg) {
                result += size(msg);
            });
        }
        return result;
    }

    ['Consumer', 'ConsumerGroup', 'HighLevelConsumer'].forEach(function(consumer) {
        shimmer.wrapMethodOnce(kafka[consumer].prototype, fmt('kafka.%s.prototype', consumer), 'on', wrapOn);
    });

    function wrapOn(on) {
        return function(event, listener) {
            if (event === 'message' && util.isFunction(listener)) {
                return on.call(this, event, wrapListener(listener));
            }
            return on.apply(this, arguments);
        }
    }

    function wrapListener(listener) {
        return tracer.actionProxy(function(message) {
            if (!agent.config.mq.enabled) {
                logger.debug('nbs.mq.enabled disabled.');
                return listener.apply(this, arguments);
            }
            var action = tracer.getAction();
            if (!action) {
                logger.debug('create action failed.');
                return listener.apply(this, arguments);
            }

            if (!message) {
                logger.debug('got empty message');
                return listener.apply(this, arguments);
            }

            var topic = message.topic;
            if (!topic) {
                logger.debug('got empty topic name');
                return listener.apply(this, arguments);
            }
            topic = topic.replace(/\//g, '%2F');

            var tingyunId;

            var type = 'Topic';
            var url = fmt('%s/%s/%s', 'Kafka', type, topic);
            var segmentInfo = {
                metric_name: "NodeJS/NULL/" + url,
                call_url: "",
                call_count: 1,
                class_name: 'Consume',
                method_name: 'on',
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

            var kafkaSegment = tracer.addSegment({
                metric_name: topic,
                call_url: "",
                call_count: 1,
                class_name: "IncomingMessage",
                method_name: 'readString',
                params: {}
            }, recorder);

            var mq = kafkaSegment.mq = {};
            mq.type = type;

            var custom = action.setCustom({}, action.statusCode);
            kafkaSegment.opType = 'Consume';

            setAddress(kafkaSegment, this.client && this.client.connectionString);
            if (kafkaSegment.host) {
                custom['message.MachineName'] = kafkaSegment.host + ':' + kafkaSegment.port;
            }
            custom['message.topic'] = topic;
            var dataSize = size(message.value);
            custom['message.byte'] = dataSize;
            mq.size = dataSize;

            segment.markAsWeb(url);

            try {
                var result = listener.apply(this, arguments);
            } catch (e) {
                action.statusCode = 500;
                kafkaSegment.end();
                segment.end();
                custom.entryTrace = getEntryTrace();
                action.end();
                throw e;
            }
            kafkaSegment.end();
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
                    "applicationId": config.transaction_tracer.tingyunIdSecret,
                    "transactionId": common.findInTingyunId(tingyunId, 'x=') || '',
                    "externalId": common.findInTingyunId(tingyunId, 'e=') || '',
                    "time": timeObj.time || {}
                };
            }
        });
    }
};

var HTTP_PROTOCAL = 'http://';

function parseConnectionString(connectionString) {
    if (!util.isString(connectionString)) {
        return {};
    }
    return url.parse(HTTP_PROTOCAL + connectionString);
}

function setAddress(segment, connectionString) {
    var address = parseConnectionString(connectionString);
    segment.host = address.hostname;
    segment.port = address.port;
}