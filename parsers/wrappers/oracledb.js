var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.oracledb');
var urltils = require('../../util/urltils');
var ParsedStatement = require('../db/parsed-statement');
var parseSql = require('../db/parse-sql');
var CallStack = require('../../util/stack');

function executeWrapper(connection, agent, tracer) {
    if (!connection || !connection.constructor || !connection.constructor.prototype || !connection.constructor.prototype.execute) {
        return logger.debug("skip wrapping operation. execute does not exist in Connection's prototype.");
    }
    shimmer.wrapMethod(connection.constructor.prototype, 'connection.constructor.prototype', 'execute', function cb_wrapMethod(execute) {
        return tracer.segmentProxy(function segmentProxyCb() {
            var args,
                length,
                parameters,
                action,
                segment,
                callback,
                sql,
                self = this,
                sqlTrace,
                actionTracer,
                existedParams = false;
            action = tracer.getAction();
            if (!action) {
                return execute.apply(this, arguments);
            }
            args = [].slice.call(arguments, 0);
            length = args.length;
            //execute api: execute(String sql, [Object bindParams, [Object options,]] function(Error error, [Object result]){});
            //if parameters don't match with api, let oracledb do its job.
            if (typeof(sql = args[0]) !== 'string' || typeof args[length - 1] !== 'function') {
                return execute.apply(this, args);
            }
            if (length > 2) {
                parameters = args.slice(1, length - 1);
            }
            segment = addOracleStatement(sql, tracer);
            if (typeof parameters === 'object') {
                urltils.copyParameters(agent.config, parameters, segment.parameters);
            }
            callback = function(last) {
                return tracer.callbackProxy(function() {
                    segment.end();
                    last.apply(this, arguments);
                });
            };
            actionTracer = agent.config.action_tracer;

            if (actionTracer.slow_sql === true) {
                sqlTrace = {
                    sql: sql,
                    stack: CallStack("Connection.execute", 2),
                };
                existedParams = /:+\d|:\S+/ig.test(sql);
                if (actionTracer.explain_enabled === true && !existedParams && !isExplainSql(sql)) {
                    callback = function(last) {
                        return tracer.callbackProxy(function() {
                            var end = Date.now();
                            if (end - segment.timer.start >= agent.config.action_tracer.explain_threshold) {
                                segment.end();
                                execute.call(self, 'EXPLAIN PLAN FOR ' + sql, function on_explain(err, data) {
                                    if (!err) {
                                        execute.call(self, 'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)', function(err, data) {
                                            tracer.callbackProxy(function() {
                                                if (!err && data && data.rows) {
                                                    var sqlExplainInfo = formatExplainInfo(data.rows);
                                                    sqlTrace.explainPlan = {
                                                        dialect: 'oracle',
                                                        keys: sqlExplainInfo.fields,
                                                        values: sqlExplainInfo.values
                                                    };
                                                }
                                                segment.end(agent.config, sqlTrace);
                                                //TODO:need double check!
                                                agent.traces._add_sql(action);
                                            }).apply(this, arguments);
                                        });
                                    }
                                });
                            } else {
                                segment.end(agent.config, sqlTrace);
                            }
                            last && last.apply(this, arguments);
                        });
                    };
                }
            }
            args = replaceCallback(args, callback);
            return execute.apply(this, args);
        });
    });
}

/*
 * rule out explain sql itself.
 */
function isExplainSql(sql) {
    if (!sql || typeof sql !== 'string') {
        return false;
    }
    if (/^\s*explain plan for.*/i.test(sql) || /^\s*select.*?\sfrom\s*.*DBMS_XPLAN.DISPLAY.*/gi.test(sql)) {
        return true;
    }
    return false;
}
/*
parse oracle sql plan trace info,something like the following:

******split line*********
Plan hash value: 3461732445

---------------------------------------------------------------------------
| Id | Operation | Name | Rows | Bytes | Cost (%CPU)| Time |
---------------------------------------------------------------------------
| 0 | SELECT STATEMENT | | 9810 | 900K| 19 (0)| 00:00:01 |
| 1 | TABLE ACCESS FULL| USERS | 9810 | 900K| 19 (0)| 00:00:01 |
---------------------------------------------------------------------------

Predicate Information (identified by operation id):
---------------------------------------------------------------------------

   1 - filter("ID">1)

Note
-----
- dynamic sampling used for this statement (level=2)
******split line*********

*/

function formatExplainInfo(sqlTraceInfo) {
    if (!sqlTraceInfo || !Array.isArray(sqlTraceInfo)) {
        return {};
    }
    var isObject,
        i = 3,
        length = sqlTraceInfo.length,
        fields,
        recordStringVal, values = [],
        record = [];
    try {
        if (Array.isArray(sqlTraceInfo[i])) {
            fields = sqlTraceInfo[i][0];
        } else {
            // when oracledb.outFormat = oracledb.OBJECT;
            isObject = true;
            fields = sqlTraceInfo[i]['PLAN_TABLE_OUTPUT'];
        }
        if (!fields) {
            return {};
        }
        fields = fields.split('|');
        fields = fields.filter(function(field) {
            return field ? (field.trim() ? field : false) : false;
        });
        for (i = i + 2; i < length; i++) {
            if (isObject) {
                recordStringVal = sqlTraceInfo[i]['PLAN_TABLE_OUTPUT'];
            } else {
                recordStringVal = sqlTraceInfo[i][0];
            }
            if (/(---)+/.test(recordStringVal)) {
                break;
            }
            record = recordStringVal.split('|');
            record.shift();
            record.pop();
            values.push(record);
        }
    } catch (e) {
        return {};
    }
    return {
        fields: fields,
        values: values
    };
}

function replaceCallback(arg, callback) {
    var last, length;
    if (!arg) {
        return arg;
    }
    length = arg.length;
    last = arg[length - 1];
    if (typeof last === 'function') {
        typeof callback === 'function' && (arg[length - 1] = callback(last));
    }
    return arg;
}

function addOracleStatement(sql, tracer) {
    var ps = parseSql("Database oralce", sql);
    var //statement = new ParsedStatement("Oracle", operation, collection),
        recorder = ps.recordMetrics.bind(ps);

    return tracer.addSegment({
        metric_name: ps.metricName(),
        call_url: "",
        call_count: 1,
        class_name: 'oracledb.Connection',
        method_name: 'execute',
        params: {}
    }, recorder);
}

module.exports = function wrapOracledb(agent, oracledb) {
    var tracer;
    if (!oracledb) {
        return logger.debug("oracledb instance is empty, skip wrapping opeartion.");
    }
    tracer = agent.tracer;

    if (oracledb.constructor && oracledb.constructor.prototype) {
        //replace oracledb.createPool
        //pool.connection's constructor should be the same with the connection's constructor returned by oracledb.getConnection()
        shimmer.wrapMethod(oracledb.constructor.prototype, 'oracledb.constructor.prototype', 'createPool', function cb_wrapMethod(createPool) {
            return function() {
                var arg = replaceCallback(arguments, function(last) {
                    return tracer.callbackProxy(function(error, pool) {
                        shimmer.wrapMethod(pool, 'pool', 'getConnection', function cb_wrapMethod(getConnection) {
                            return function() {
                                var arg = replaceCallback(arguments, function(last) {
                                    return tracer.callbackProxy(function(error, connection) {
                                        executeWrapper(connection, agent, tracer);
                                        last.apply(this, arguments);
                                    });
                                });
                                getConnection.apply(this, arg);
                            }
                        });
                        last.apply(this, arguments);
                    });
                });
                createPool.apply(this, arg);
            }
        });

        //replace oracledb.getConnection
        shimmer.wrapMethod(oracledb.constructor.prototype, 'oracledb.constructor.prototype', 'getConnection', function cb_wrapMethod(getConnection) {
            return function() {
                var arg = replaceCallback(arguments, function(last) {
                    return tracer.callbackProxy(function(error, connection) {
                        executeWrapper(connection, agent, tracer);
                        last.apply(this, arguments);
                    });
                });
                getConnection.apply(this, arg);
            };
        });
    }
};