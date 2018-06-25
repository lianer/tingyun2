'use strict';

var shimmer = require('../../util/shimmer');
var record = require('../../metrics/recorders/cache_storage.js')('Redis');
var cmd_map = require('./redis-common/command');
var util = require('util');

module.exports = function initialize(agent, Redis) {
    var tracer = agent.tracer;

    if (!(Redis && Redis.prototype)) {
        return;
    }

    shimmer.wrapMethod(Redis.prototype, 'Redis.prototype', 'sendCommand', function wrapper(sendCommand) {
        return tracer.segmentProxy(function wrapped(command, stream, node) {
            if (!agent.config.enabled || !tracer.getAction() || !arguments.length) {
                return sendCommand.apply(this, arguments);
            }

            var host, port, db;
            if (this.options) {
                host = this.options.host;
                port = this.options.port;
            }
            if (this.condition) {
                db = this.condition.select;
            }
            host = host || 'localhost';
            port = (port === 0) ? port : (port || 6379);
            db = db || 0;

            var commandName = command.name;

            //Redis/HOST:PORT%2FDATABASE_INDEX/OP_TYPE
            var name = util.format('%s/%s:%d%s%s/%s', 'Redis', host, port, '%2F', db, cmd_map.__name_map(commandName));
            var segmentInfo = {
                metric_name: name,
                call_url: "",
                call_count: 1,
                class_name: "Redis",
                method_name: 'sendCommand.' + commandName,
                params: {}
            };
            var segment = tracer.addSegment(segmentInfo, record);
            segment.host = host;
            segment.port = port;
            segment.database = db;
            var keyValuePair = command.args;

            if (keyValuePair && agent.config.capture_params && typeof keyValuePair !== 'function' && agent.config.ignored_params.indexOf('key') === -1) {
                segment.parameters.key = JSON.stringify([keyValuePair[0]]);
            }

            command.promise.finally(function() {
                segment.end();
            });

            return sendCommand.call(this, command, stream, node);
        });
    });
};