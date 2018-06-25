'use strict';

var shimmer = require('../../util/shimmer.js');
var record = require('../../metrics/recorders/cache_storage.js')('Memcached');
var logger = require('../../util/logger').child('parsers.wrappers.memcached');
var HOST_PORT_REG = /(.+):(\d+)$/;
var util = require('../../util/util');

function wrapKeys(metacall) {
    if (metacall.key) {
        return [metacall.key];
    } else if (metacall.multi) {
        return metacall.command.split(' ').slice(1);
    }
    return [];
}

module.exports = function initialize(agent, memcached) {
    var tracer = agent.tracer;
    if (!memcached || !memcached.prototype) {
        return logger.verbose("memcached object or its prototype is null");
    }

    var connect = memcached.prototype.connect;

    shimmer.wrapMethod(memcached.prototype, 'memcached.prototype', 'command', function wp(command) {
        return tracer.segmentProxy(function proxy() {
            if (!tracer.getAction()) {
                return command.apply(this, arguments);
            }

            var metacall = arguments[0]();
            var name = 'Memcached/NULL/' + (metacall.type || 'Unknown');
            var segment_info = {
                metric_name: name,
                call_url: '',
                call_count: 1,
                class_name: 'memcached',
                method_name: 'command',
                params: {}
            };

            var segment = tracer.addSegment(segment_info, record);
            var keys = wrapKeys(metacall);

            if (agent.config.capture_params && keys.length > 0 && agent.config.ignored_params.indexOf('key') === -1) {
                segment.parameters.key = JSON.stringify(keys);
            }
            shimmer.wrapMethod(metacall, 'metacall', 'callback', function wrap_cb(cb) {
                return tracer.callbackProxy(function proxy() {
                    segment.end();
                    return cb.apply(this, arguments);
                });
            });

            var rewrapped = function rewrapped() {
                return metacall;
            };

            this.connect = function(server) {
                if (!server || !util.isString(server)) {
                    return connect.apply(this, arguments);
                }
                if (!server.match(HOST_PORT_REG)) {
                    segment.host = server;
                    // Default port to 11211
                    server.port = 11211;
                } else {
                    var tokens = server.split(':');
                    segment.host = tokens[0];
                    segment.port = parseInt(tokens[1]);
                }
                this.connect = connect;
                return connect.apply(this, arguments);
            };

            arguments[0] = rewrapped;

            return command.apply(this, arguments);
        });
    });
};