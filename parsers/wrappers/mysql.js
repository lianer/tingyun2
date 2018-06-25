'use strict';

var CallStack = require('../../util/stack');
var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.mysql');
var util = require('../../util/util');
var parseSql = require('../db/parse-sql');
var confuse = require('../../ext/ext_main').confusion;

module.exports = function initialize(agent, mysql) {
    var tracer = agent.tracer;

    shimmer.wrapMethod(mysql, 'mysql', 'createConnection', function wrapCreateConnection(createConnection) {
        return function createConnectionProxy(config) {
            var connection = createConnection.call(this, config);
            shimmer.wrapMethod(connection, 'connection', 'query', wrapQuery);
            return connection;
        }
    });

    shimmer.wrapMethod(mysql, 'mysql', 'createPool', function wrapCreatePool(createPool) {
        return function createPoolProxy(config) {
            var pool = createPool.call(this, config);
            shimmer.wrapMethod(pool, 'pool', 'getConnection', function wrapGetConnection(getConnection) {
                return function getConnectionProxy(cb) {
                    var callback = cb;
                    if (typeof cb === 'function') {
                        callback = tracer.callbackProxy(function getConnectionCallbackProxy(error, connection) {
                            connection && shimmer.wrapMethod(connection, 'connection', 'query', wrapQuery);
                            return cb.call(this, error, connection);
                        });
                    }
                    return getConnection.call(this, callback);
                }
            });
            return pool;
        };
    });

    shimmer.wrapMethod(mysql, 'mysql', 'createPoolCluster', function wrapCreatePoolCluster(createPoolCluster) {
        return function createPoolClusterProxy(config) {
            var cluster = createPoolCluster.call(this, config);
            shimmer.wrapMethod(cluster, 'cluster', '_getConnection', function wrapClusterGetConnection(_getConnection) {
                return function _getConnectionProxy(node, cb) {
                    var callback = tracer.callbackProxy(function _getConnectionCallbackProxy(error, connection) {
                        connection && shimmer.wrapMethod(connection, 'connection', 'query', wrapQuery);
                        return cb.call(this, error, connection);
                    });
                    return _getConnection.call(this, node, callback);
                }
            });
            return cluster;
        };
    });

    function wrapQuery(query) {
        return tracer.segmentProxy(function queryProxy(sql, values, cb) {
            if (!agent.enabled()) {
                logger.debug('agent disabled.');
                return query.call(this, sql, values, cb);
            }
            var action = tracer.getAction();
            if (!action) {
                logger.debug('no action.');
                return query.call(this, sql, values, cb);
            }

            var _constructor = this.constructor;
            var createQuery = _constructor.createQuery || _constructor.super_ && _constructor.super_.createQuery;
            if (!createQuery) {
                logger.debug('can not find Connection.createQuery, update mysql lib to v2.10.0+');
                return query.call(this, sql, values, cb);
            }

            var q = createQuery(sql, values, cb);

            var sqlString = q.sql;
            if (!sqlString) {
                logger.debug('empty sql statement!');
                return query.call(this, q);
            }
            if (q._explain) {
                logger.debug('ignore explain sql!');
                return query.call(this, q);
            }

            var self = this;

            var hasCallback = true;
            var callback = q._callback;
            if (typeof callback === 'function') {
                q._callback = tracer.callbackProxy(function _queryCallbackProxy(error) {
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

            var ps = parseSql("Database mysql", sqlString);
            var segmentInfo = {
                metric_name: ps.metricName(),
                call_url: "",
                call_count: 1,
                class_name: 'Connection',
                method_name: 'query',
                params: {}
            };
            var segment = tracer.addSegment(segmentInfo, ps.recordMetrics.bind(ps));
            var config = agent.config;
            var actionTracer = config.action_tracer;
            var sqlConfusion = actionTracer.record_sql;
            if (sqlConfusion === 'obfuscated') {
                segment.parameters.sql = confuse(sqlString);
            } else if (sqlConfusion === 'raw') {
                segment.parameters.sql = sqlString;
            }

            var sqlTrace;

            if (this.config) {
                segment.port = this.config.port;
                segment.host = this.config.host;
                segment.database = this.config.database;
            }

            var result = query.call(this, q);

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
                var segmentDuration = segment.getDurationInMillis();
                if (segmentDuration > actionTracer.stack_trace_threshold) {
                    stacktrace = CallStack("Connection.query", 2);
                    segment.parameters.stacktrace = stacktrace;
                }
                if (actionTracer.slow_sql === true && segmentDuration > actionTracer.slow_sql_threshold) {
                    logger.debug('slow sql tracer on.');
                    sqlTrace = {
                        sql: segment.parameters.sql || null,
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
                if (!result) {
                    return logger.error('query no result.');
                } else if (invalidSql(result.sql)) {
                    msg = 'sql is invalid for explaining: ' + result.sql;
                }
                if (msg) {
                    segment.end(config, sqlTrace);
                    return logger.error(msg);
                }
                var explainQuery = createQuery('explain ' + result.sql, result.values || [], function(err, rows, fields) {
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
                explainQuery._explain = true;
                self.query.call(self, explainQuery);
            }
        });
    }
};

var VALID_DML_REQ = /^(\s+)?(select|insert|update|delete).+/i;

function invalidSql(sql) {
    return !(sql && !isMultipleSql(sql) && VALID_DML_REQ.test(sql));
}

function isMultipleSql(sql) {
    return sql.indexOf(';') > -1;
}