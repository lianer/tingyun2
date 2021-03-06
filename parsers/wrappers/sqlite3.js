'use strict';
var CallStack = require('../../util/stack');
var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.sqlite3');
var parseSql = require('../db/parse-sql');

module.exports = function initialize(agent, sqlite3) {
    var tracer = agent.tracer;
    if (!(sqlite3 && sqlite3.Database && sqlite3.Database.prototype && sqlite3.Statement && sqlite3.Statement.prototype)) {
        return;
    }

    function method_wrapper(name, method) {
        return tracer.segmentProxy(function() {
            if (!agent.config.enabled) {
                return method.apply(this, arguments);
            }
            if (!tracer.getAction() || arguments.length < 1) {
                return method.apply(this, arguments);
            }
            var action = tracer.getAction();
            var args = tracer.slice(arguments);
            var last = args[args.length - 1];
            var ended = false;
            var sql_trace;
            var self = this;
            var in_evt = false;
            var ps = parseSql("Database sqlite3", this.sql);
            var segment_info = {
                metric_name: ps.metricName(),
                call_url: "",
                call_count: 1,
                class_name: 'sqlite3.Statement',
                method_name: name,
                params: {}
            };
            var wrapped;
            if (tracer.agent.config.action_tracer.slow_sql === true) {
                sql_trace = {
                    sql: this.sql,
                    stack: CallStack("sqlite3.Statement." + name, 2)
                };
            }
            var segment = tracer.addSegment(segment_info, ps.recordMetrics.bind(ps));

            function on_query_back() {
                if (ended && in_evt) {
                    return;
                }
                if (!ended) {
                    segment.end(tracer.agent.config, sql_trace);
                    ended = true;
                }
                if (!in_evt) {
                    return wrapped.apply(this, arguments);
                }
            }
            if (typeof last === 'function') {
                wrapped = tracer.callbackProxy(last);
                args[args.length - 1] = on_query_back;
            } else if (Array.isArray(last) && last.length > 0 && typeof last[last.length - 1] === 'function') {
                wrapped = tracer.callbackProxy(last[last.length - 1]);
                last[last.length - 1] = on_query_back;
            } else {
                args.push(function cb() {
                    segment.end();
                });
            }
            var res = method.apply(this, args);
            var _end;

            function on_end() {
                in_evt = true;
                _end.apply(this, arguments);
                in_evt = false;
            }
            if (!wrapped) {
                _end = tracer.callbackProxy(on_query_back);
                res.on('error', on_end);
                res.on('end', on_end);
            }
            return res;
        });
    }
    ['run', 'get', 'all', 'each'].forEach(function cb_forEach(method) {
        shimmer.wrapMethod(sqlite3.Statement.prototype, 'sqlite3.Statement.prototype', method, method_wrapper.bind(null, method));
    });
};