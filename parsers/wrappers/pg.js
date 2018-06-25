'use strict';

var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.pg');
var parseSql = require('../db/parse-sql');
var CallStack = require('../../util/stack');

function get_sql(param) {
    if (param && (typeof param === 'string' || param instanceof String)) {
        return param;
    }
    if (param && param.hasOwnProperty('text')) {
        return param.text;
    }
    return 'Other';
}

module.exports = function initialize(agent, pgsql) {
    var tracer = agent.tracer;

    function on_query(query, connection) {
        return function wrapQuery() {
            var config = agent.config;
            if (!config.enabled) {
                return query.apply(this, arguments);
            }
            if (!tracer.getAction() || arguments.length < 1) {
                return query.apply(this, arguments);
            }
            var action = tracer.getAction();
            var args = tracer.slice(arguments);
            var last = args[args.length - 1];

            var ended = false;
            var sql_trace;
            var self = this;
            var in_evt = false;
            var statement = get_sql(arguments[0]);
            var ret_callback;
            var explain_args = [];

            function on_explain(err, result) {
                if (!err) {
                    var rows = result.rows;
                    var fields = result.fields;
                    var keys = [];
                    for (var i = 0; i < fields.length; i++) {
                        keys[i] = fields[i].name;
                    }

                    var values = [];
                    for (var r = 0; r < rows.length; r++) {
                        var data = [];
                        for (var i = 0; i < keys.length; i++) {
                            data[i] = rows[r][keys[i]];
                        }
                        values[r] = data;
                    }
                    sql_trace.explainPlan = {
                        dialect: 'pg',
                        keys: keys,
                        values: values
                    };
                }
                segment.end(config, sql_trace);
            }

            function on_query_back() {
                if (ended && in_evt) {
                    return;
                }
                if (!ended) {
                    var query_end_time = Date.now();
                    if (ret_callback && query_end_time - segment.timer.start >= config.action_tracer.explain_threshold) {
                        segment.end();
                        explain_args[explain_args.length - 1] = on_explain;
                        query.apply(self, explain_args);
                    } else {
                        segment.end(config, sql_trace);
                    }
                    ended = true;
                }

                if (!in_evt) {
                    return wrapped.apply(this, arguments);
                }
            }

            var ps = parseSql("Database PostgreSQL", statement);
            var segment_info = {
                metric_name: ps.metricName(),
                call_url: "",
                call_count: 1,
                class_name: (connection ? 'Client.Connection' : 'pg.Client'),
                method_name: 'query',
                params: {}
            }
            var wrapped;
            if (config.action_tracer.slow_sql === true) {
                if (config.action_tracer.explain_enabled === true) {
                    ret_callback = on_query_back;
                }
                sql_trace = {
                    sql: statement,
                    stack: CallStack("Connection.query", 2),
                };
            }
            if (ret_callback) {
                for (var i = 0; i < args.length; i++) {
                    explain_args[i] = args[i];
                }
            }
            var segment = tracer.addSegment(segment_info, ps.recordMetrics.bind(ps));

            if (typeof last === 'function') {
                wrapped = tracer.callbackProxy(last);
                args[args.length - 1] = (typeof ret_callback === 'function') ? ret_callback : wrapped;
                if (ret_callback) {
                    explain_args[0] = 'explain ' + statement;
                }
            } else if (!connection && Array.isArray(last) && typeof last[last.length - 1] === 'function') {
                wrapped = tracer.callbackProxy(last[last.length - 1]);
                last[last.length - 1] = (typeof ret_callback === 'function') ? ret_callback : wrapped;
            }

            if (connection) {
                segment.host = connection.host;
                segment.port = connection.port;
            }
            var res = query.apply(this, args);
            var _end = tracer.callbackProxy(on_query_back);

            function on_end() {
                in_evt = true;
                _end.apply(this, arguments);
                in_evt = false;
            }

            if (res.on) {
                res.on('error', on_end);
                res.on('end', on_end);
            } else {
                res.then(function(data) {
                    on_end();
                    return data;
                }, function(error) {
                    on_end();
                    throw error;
                });
            }

            function on_wrap_listen_on(on) {
                return tracer.callbackProxy(function queryOnWrapped() {
                    if (typeof arguments[1] === 'function') {
                        arguments[1] = tracer.callbackProxy(arguments[1]);
                    }
                    return on.apply(this, arguments);
                });
            }
            shimmer.wrapMethod(res, 'query.on', 'on', on_wrap_listen_on);
            shimmer.wrapMethod(res, 'query.addListener', 'addListener', on_wrap_listen_on);
            return res;
        }
    }

    function _client_wrapper(client) {
        return function wrapClient() {
            var connection = client.apply(this, arguments);
            shimmer.wrapMethod(connection, 'Connection', 'connect', function conn_wrapper(connect) {
                return function wrapConnect(callback) {
                    if (typeof callback === 'function') {
                        callback = tracer.callbackProxy(callback);
                    }
                    return connect.call(this, callback);
                }
            });
            shimmer.wrapMethod(connection, 'Connection', 'query', function query_wrap(query) {
                return on_query(query, connection);
            });
            return connection;
        }
    }
    //wrapping for native
    function wrap_native(eng, pg) {
        shimmer.wrapMethod(pg, eng, 'Client', _client_wrapper);
        shimmer.wrapMethod(pg.pools, eng + '.pools', 'Client', _client_wrapper);
    }
    //allows for native wrapping to not happen if not neccessary
    //when env var is true
    if (process.env.NODE_PG_FORCE_NATIVE) {
        wrap_native('pg', pgsql);
    }
    //using ('pg').native in their require
    else {
        var origGetter = pgsql.__lookupGetter__('native');
        delete pgsql.native;
        pgsql.__defineGetter__('native', function() {
            var temp = origGetter();
            wrap_native('pg.native', pgsql.native);
            return temp;
        });
    }
    if (pgsql && pgsql.Client && pgsql.Client.prototype) {
        shimmer.wrapMethod(pgsql.Client.prototype, 'pg.Client.prototype', 'query', function query_wrap(query) {
            return on_query(query);
        });
    }
}