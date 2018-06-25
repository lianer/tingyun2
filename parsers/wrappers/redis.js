'use strict';

var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.redis');
var record = require('../../metrics/recorders/cache_storage.js')('Redis');
var cmd_map = require('./redis-common/command');
var util = require('../../util/util');
var nativeUtil = require('util');

function getAddress(obj) {
    var host = obj.host ? obj.host : (obj.address ? obj.address.split(':')[0] : 'localhost');
    var port = 6379;
    if (obj.port) {
        port = obj.port;
    } else if (obj.address) {
        var addr = obj.address.split(':');
        if (addr.length > 1) {
            port = addr[1];
        }
    }
    return {
        host: host,
        port: port
    };
}

function getMetricName(host, port, dbIndex, command) {
    return nativeUtil.format('%s/%s:%d%s%s/%s', 'Redis', host, port, '%2F', dbIndex, cmd_map.__name_map(command));
}

module.exports = function initialize(agent, redis) {
    var tracer = agent.tracer;
    if (!(redis && redis.RedisClient && redis.RedisClient.prototype)) {
        return;
    }
    shimmer.wrapMethod(redis.RedisClient.prototype, 'redis.RedisClient.prototype', 'send_command', function wrapper(send_command) {
        return tracer.segmentProxy(function wrapped() {
            var action;
            if (!agent.enabled() || !(action = tracer.getAction()) || arguments.length < 1) {
                return send_command.apply(this, arguments);
            }
            var args = tracer.slice(arguments);
            var serverInfo = getAddress(this);
            var segmentInfo = {
                metric_name: getMetricName(serverInfo.host, serverInfo.port, this.selected_db || 0, args[0]),
                call_url: "",
                call_count: 1,
                class_name: "redis.RedisClient",
                method_name: 'send_command.' + args[0],
                params: {}
            };
            var segment = tracer.addSegment(segmentInfo, record),
                position = args.length - 1,
                keys = args[1],
                last = args[position];

            segment.host = serverInfo.host;
            segment.port = serverInfo.port;
            segment.database = this.selected_db;

            if (agent.config.capture_params && keys && typeof keys !== 'function' && agent.config.ignored_params.indexOf('key') === -1) {
                segment.parameters.key = JSON.stringify([keys[0]]);
            }

            function proxy(target) {
                return function cls_finalize() {
                    segment.end();
                    return target.apply(this, arguments);
                };
            }

            if (typeof last === 'function') {
                args[position] = tracer.callbackProxy(proxy(last));
            } else if (Array.isArray(last) && typeof last[last.length - 1] === 'function') {
                var callback = proxy(last[last.length - 1]);
                last[last.length - 1] = tracer.callbackProxy(callback);
            } else {
                args.push(function cb() {
                    segment.end();
                });
            }
            return send_command.apply(this, args);
        });
    });

    shimmer.wrapMethod(redis.RedisClient.prototype, 'redis.RedisClient.prototype', 'internal_send_command', function wrapper(internalSendCommand) {
        return tracer.segmentProxy(function internalSendCommandWrap(cmd) {
            var action;
            if (!agent.enabled() || !(action = tracer.getAction()) || !cmd) {
                return internalSendCommand.apply(this, arguments);
            }
            var serverInfo = getAddress(this.connection_options);
            var segmentInfo = {
                metric_name: getMetricName(serverInfo.host, serverInfo.port, this.selected_db || 0, cmd.command),
                call_url: "",
                call_count: 1,
                class_name: "redis.RedisClient",
                method_name: 'internal_send_command.' + cmd.command,
                params: {}
            };
            var segment = tracer.addSegment(segmentInfo, record);

            segment.host = serverInfo.host;
            segment.port = serverInfo.port;
            segment.database = this.selected_db;

            var callback = cmd.callback;
            if (util.isFunction(callback)) {
                cmd.callback = tracer.callbackProxy(proxy(callback));
            } else {
                cmd.callback = function() {
                    segment.end();
                };
            }

            function proxy(target) {
                return function() {
                    segment.end();
                    return target.apply(this, arguments);
                };
            }

            return internalSendCommand.apply(this, arguments);
        });
    });
};