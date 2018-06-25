'use strict';

var CallStack = require('../../util/stack');
var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.mysql2');
var parseSql = require('../db/parse-sql');
var confuse = require('../../ext/ext_main').confusion;
var util = require('../../util/util');

module.exports = function(agent, mysql2) {
    if (!mysql2 || !mysql2.Connection) {
        return logger.verbose("mysql2.Connection does not exists, skip wrapping.");
    }
    var tracer = agent.tracer;
    shimmer.wrapMethod(mysql2.Connection.prototype, 'mysql2.Connection.prototype', ['execute', 'query'], function(method, methodName) {
        return tracer.segmentProxy(function(sql) {
            if (!agent.enabled()) {
                logger.debug('agent disabled, skip monitoring method(%s).', methodName);
                return method.apply(this, arguments);
            }
            var action = agent.getAction();
            if (!action) {
                logger.debug('current async context is null, can not get proper action.');
                return method.apply(this, arguments);
            }

            var sqlStatement;
            if (util.isString(sql)) {
                sqlStatement = sql;
            } else if (util.isObject(sql)) {
                sqlStatement = sql.sql;
            }
            if (!sqlStatement || !util.isString(sqlStatement)) {
                logger.debug('possiblely got illegal arguments.', arguments);
                return method.apply(this, arguments);
            }
            if (isExplainSql(sqlStatement)) {
                logger.debug('ignore explain sql statement.');
                return method.apply(this, arguments);
            }

            var config = agent.config;
            var hasCallback = true;
            var callbackIndex = arguments.length - 1;
            var callback = arguments[callbackIndex];
            if (util.isFunction(callback)) {
                arguments[callbackIndex] = tracer.callbackProxy(function(error) {
                    var sql;
                    if (error) {
                        sql = segment.parameters.sql;
                        if (sql) {
                            error.message = error.message + ' ' + sql.substr(0, 1024);
                        }
                        var exceptions = segment.parameters.exception = segment.parameters.exception || [];
                        exceptions.push({
                            message: error.message,
                            class: util.getErrorClassName(error),
                            stacktrace: error.stack && error.stack.split('\n')
                        });
                        action.addExceptions(error);
                    }
                    endSegment();
                    return callback.apply(this, arguments);
                });
            } else {
                hasCallback = false;
            }

            var self = this;
            var ps = parseSql("Database mysql", sqlStatement);
            var segment = tracer.addSegment({
                metric_name: ps.metricName(),
                call_url: "",
                call_count: 1,
                class_name: 'mysql2.Connection',
                method_name: methodName,
                params: {}
            }, ps.recordMetrics.bind(ps));

            var actionTracer = config.action_tracer;
            var sqlConfusion = actionTracer.record_sql;
            if (sqlConfusion === 'obfuscated') {
                segment.parameters.sql = confuse(sqlStatement);
            } else if (sqlConfusion === 'raw') {
                segment.parameters.sql = sqlStatement;
            }

            var sqlTrace;

            if (this.config) {
                segment.port = this.config.port;
                segment.host = this.config.host;
                segment.database = this.config.database;
            }

            var result = method.apply(this, arguments);
            result.once('end', function() {
                if (!hasCallback) {
                    endSegment();
                }
            });
            return result;

            function endSegment() {
                if (!segment) {
                    return logger.error('segment is null, can not end it.');
                }
                var stacktrace;
                var segmentDuration = Date.now() - segment.timer.start;
                if (segmentDuration > actionTracer.stack_trace_threshold) {
                    stacktrace = CallStack("Connection.query", 2);
                    segment.parameters.stacktrace = stacktrace;
                }
                if (actionTracer.slow_sql === true && segmentDuration > actionTracer.slow_sql_threshold) {
                    logger.debug('slow sql tracer on.');
                    sqlTrace = {
                        sql: segment.parameters.sql,
                        stack: stacktrace || null
                    };

                    if (actionTracer.explain_enabled === true && segmentDuration >= actionTracer.explain_threshold) {
                        logger.debug('over explain sql threshold.');
                        segment.end();
                        explainSql();
                    } else {
                        segment.end(config, sqlTrace);
                    }
                } else {
                    segment.end();
                }
            }

            function explainSql() {
                var msg;
                var options;
                if (!result) {
                    msg = 'can not get command';
                } else {
                    options = result.options || result._executeOptions || result._queryOptions || {};
                    if (invalidSql(options.sql)) {
                        msg = 'sql is invalid, can not execute sql explain for statement: ' + options.sql;
                    }
                }
                if (msg) {
                    segment.end(config, sqlTrace);
                    return logger.error(msg);
                }
                self.query.call(self, 'explain ' + options.sql, options.values || [], function(err, rows, fields) {
                    if (!err && rows && fields) {
                        var keys = [];
                        fields.forEach(function(field, index) {
                            keys[index] = field.name;
                        });
                        var values = [];
                        rows.forEach(function(row, index) {
                            var data = [];
                            keys.forEach(function(key, keyIndex) {
                                data[keyIndex] = rows[index][keys[keyIndex]];
                            });
                            values[index] = data;
                        });
                        sqlTrace.explainPlan = {
                            dialect: 'mysql',
                            keys: keys,
                            values: values
                        };
                        segment.parameters.explainPlan = sqlTrace.explainPlan;
                    }
                    segment.end(config, sqlTrace);
                    agent.traces._add_sql(action);
                });
            }
        });
    });
};

var VALID_DML_REQ = /^(\s+)?(select|insert|update|delete).+/i;
var EXPLAIN_REQ = /^(\s+)?(explain).+/i;

function invalidSql(sql) {
    return !(sql && !isMultipleSql(sql) && VALID_DML_REQ.test(sql));
}

function isMultipleSql(sql) {
    return sql.indexOf(';') > -1;
}

function isExplainSql(sql) {
    return EXPLAIN_REQ.test(sql);
}