'use strict';

var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.node-cassandra-cql');
var record = require('../../metrics/recorders/cache_storage.js')('Cassandra');

var WRAP_METHODS = ['execute', 'executeAsPrepared', 'executeBatch'];

module.exports = function initialize(agent, cassandracql) {
    var tracer = agent.tracer;

    WRAP_METHODS.forEach(function cb_forEach(operation) {
        if (!(cassandracql && cassandracql.Client && cassandracql.Client.prototype)) return;
        shimmer.wrapMethod(cassandracql.Client.prototype, 'node-cassandra-cql.Client.prototype', operation, function wrapper(cmd) {
            return tracer.segmentProxy(function wrapped() {
                if (!tracer.getAction() || arguments.length < 1) {
                    return cmd.apply(this, arguments);
                }
                var action = tracer.getAction();
                var args = tracer.slice(arguments);
                var name = 'Cassandra/NULL/' + operation;

                var segment_info = {
                    metric_name: name,
                    call_url: "",
                    call_count: 1,
                    class_name: 'node-cassandra-cql.Client',
                    method_name: operation,
                    params: {}
                };

                var segment = tracer.addSegment(segment_info, record);
                var position = args.length - 1;
                var last = args[position];

                segment.port = this.port;
                segment.host = this.host;

                function proxy(cb) {
                    return function wrap() {
                        segment.end();
                        return cb.apply(this, arguments);
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
                return cmd.apply(this, args);
            });
        });
    });
};