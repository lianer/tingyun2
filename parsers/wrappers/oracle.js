var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.oracle');
var urltils = require('../../util/urltils');
var ParsedStatement = require('../db/parsed-statement');
var parseSql = require('../db/parse-sql');
var CallStack = require('../../util/stack');

function addOracleStatement(sql, tracer, className, methodName) {
    var ps = parseSql("Database oralce", sql),
        recorder = ps.recordMetrics.bind(ps);
    return tracer.addSegment({
        metric_name: ps.metricName(),
        call_url: "",
        call_count: 1,
        class_name: className || 'oracle.Connection',
        method_name: methodName || 'execute',
        params: {}
    }, recorder);
}

module.exports = function wrapOracle(agent, oracle) {
    var tracer;
    if (!oracle) {
        return logger.info("oracle instance is empty, skip wrapping opeartion.");
    }
    tracer = agent.tracer;

    shimmer.wrapMethod(oracle, 'oracle', 'connectSync', function cb_wrapMethod(originalConnectSync) {
        return function(connectData, callback) {
            var connection = originalConnectSync.apply(this, arguments);
            wrapConnection(connection);
            return connection;
        }
    });

    shimmer.wrapMethod(oracle, 'oracle', 'connect', function cb_wrapMethod(originalConnect) {
        return function(connectData, callback) {
            originalConnect.call(this, connectData, tracer.callbackProxy(function(error, connection) {
                wrapConnection(connection);
                callback(error, connection);
            }));
        }
    });

    function wrapConnection(connection) {
        if (connection && !connection['__TINGYUN__WRAPPED__']) {
            wrapAllNecessary(connection);
            connection['__TINGYUN__WRAPPED__'] = true;
        }
    }

    function wrapAllNecessary(connection) {
        var _proto;
        if (connection.constructor && (_proto = connection.constructor.prototype)) {
            wrappExecute(_proto);
            wrapPrepare(_proto, connection);
            wrapReader(_proto, connection);
        }
    }

    function wrapNextRow(sql, tracer, original, methodName) {
        return function() {
            var segment;
            //https://github.com/joeferner/node-oracle
            //nextRows uses the prefetch row count when count is omitted. Also, you much check for row.length since the reader will continue returning 
            //empty arrays once it exceeds the end of the data set provided by the query.
            try {
                segment = addOracleStatement(sql, tracer, 'oracle.Connection.reader', methodName);
            } catch (e) {
                logger.debug('the reader will continue returning empty arrays once it exceeds the end of the data ' +
                    'set provided by the query,try return your callback function.');
                return original.apply(this, arguments);
            }
            (function (argument, segment) {
                var callback, last = argument.length - 1;
                if (last > -1 && typeof (callback = argument[last]) === 'function') {
                    argument[last] = function(){
                        segment && segment.end();
                        callback.apply(this, arguments);
                    };
                }
            })(arguments, segment);
            return original.apply(this, arguments);
        };
    }

    function wrapReader(_proto, connection) {
        shimmer.wrapMethod(_proto, 'connection.constructor.prototype', 'reader', function cb_wrapMethod(reader) {
            return function(sql) {
                var readerResult = reader.apply(this, arguments);
                var action = tracer.getAction();
                if (!action) {
                    logger.debug('action is not available.');
                }
                shimmer.wrapMethod(readerResult, 'connection.reader.nextRow', 'nextRow', function cb_wrapMethod(nextRow) {
                    return wrapNextRow(sql, tracer, nextRow, 'nextRow');
                });
                shimmer.wrapMethod(readerResult, 'connection.reader.nextRows', 'nextRows', function cb_wrapMethod(nextRows) {
                    return wrapNextRow(sql, tracer, nextRows, 'nextRows');
                });
                return readerResult;
            }
        });
    }

    function parseArguments(tracer, argument, plugin) {
        var args = [].slice.call(argument, 0),
            length, parameters, sql;
        var failed = !(length = args.length) || typeof(original = args[length - 1]) !== 'function';
        if (!failed) {
            args[length - 1] = tracer.callbackProxy(function() {
                plugin && plugin.apply(this, arguments);
                original.apply(this, arguments);
            });
            if (typeof args[0] === 'string') {
                sql = args[0];
            }
            parameters = args.slice((sql ? 1 : 0), length - 1);
        }
        return {
            failed: failed,
            args: args,
            parameters: parameters,
            sql: sql || ''
        };
    }

    function wrapPrepare(_proto, connection) {
        shimmer.wrapMethod(_proto, 'connection.constructor.prototype', 'prepare', function cb_wrapMethod(prepare) {
            return function(sql) {
                return wrapExecuteOfStatement(prepare.apply(this, arguments), sql);
            }
        });
    }

    function wrapExecuteOfStatement(statement, sql) {
        shimmer.wrapMethod(statement, 'connection.prepare', 'execute', function(execute) {
            return tracer.segmentProxy(function() {
                var actionTracer,
                    action = tracer.getAction(),
                    segment = addOracleStatement(sql, tracer, 'oracle.Connection.statement'),
                    actualCallback = function() {
                        segment.end();
                    };
                actionTracer = agent.config.action_tracer;
                if (actionTracer.slow_sql === true) {
                    if (actionTracer.explain_enabled === true && !/:\d+/ig.test(sql)) {
                        actualCallback = getActualExecuteCallback({
                            sql: sql,
                            stack: CallStack("Connection.prepare.execute", 2),
                        }, agent, action, segment, connection.execute, connection);
                    }
                }
                var parseResult = parseArguments(tracer, arguments, actualCallback);
                if (parseResult.failed) {
                    return execute.apply(this, arguments);
                }
                execute.apply(this, parseResult.args);
            });
        });
        return statement;
    }

    function wrappExecute(_proto) {
        shimmer.wrapMethod(_proto, 'connection.constructor.prototype', 'execute', function cb_wrapMethod(execute) {
            return tracer.segmentProxy(function segmentProxyCb() {
                var action = tracer.getAction(),
                    segment, parsedArgs, actualCallback, sqlTrace, sql;
                if (!action) {
                    logger.debug('action does not exist, skip wrapping execute method');
                    return execute.apply(this, arguments);
                }
                actualCallback = function() {
                    segment.end();
                };
                sql = arguments[0];
                if (typeof sql === 'string') {
                    segment = addOracleStatement(sql, tracer);
                    actionTracer = agent.config.action_tracer;
                    if (actionTracer && actionTracer.slow_sql === true) {
                        if (actionTracer.explain_enabled === true && !/:\d+/ig.test(sql)) {
                            actualCallback = getActualExecuteCallback({
                                sql: sql,
                                stack: CallStack("Connection.execute", 2)
                            }, agent, action, segment, execute, this);
                        }
                    }
                }
                parsedArgs = parseArguments(tracer, arguments, actualCallback);
                if (parsedArgs.failed) {
                    return execute.apply(this, arguments);
                }
                if (typeof parsedArgs.parameters === 'object') {
                    urltils.copyParameters(agent.config, parsedArgs.parameters, segment.parameters);
                }
                return execute.apply(this, parsedArgs.args);
            });
        });
    }

    function getActualExecuteCallback(sqlTrace, agent, action, segment, execute, context) {
        return function() {
            var end = Date.now();
            if (end - segment.timer.start < agent.config.action_tracer.explain_threshold) {
                return segment.end(agent.config, sqlTrace);
            }
            segment.end();
            if (!isExplainSql(sqlTrace.sql)) {
                getExplain(execute, context, sqlTrace.sql, function(error, explain) {
                    if (!error && explain) {
                        var sqlExplainInfo = formatExplainInfo(explain);
                        sqlTrace.explainPlan = {
                            dialect: 'oracle',
                            keys: sqlExplainInfo.fields,
                            values: sqlExplainInfo.values
                        };
                    }
                    segment.end(agent.config, sqlTrace);
                    //TODO:need double check!
                    agent.traces._add_sql(action);
                });
            }
        }
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

    function formatExplainInfo(sqlTraceInfo) {
        if (!sqlTraceInfo || !Array.isArray(sqlTraceInfo)) {
            return {};
        }
        try {
            var i = 3,
                length = sqlTraceInfo.length,
                fields = sqlTraceInfo[i],
                recordStringVal, values = [],
                record = [];
            if (!fields) {
                return {};
            }
            fields = fields['PLAN_TABLE_OUTPUT'].split('|');
            fields = fields.filter(function(field) {
                return field ? (field.trim() ? field : false) : false;
            });
            for (i = i + 2; i < length; i++) {
                recordStringVal = sqlTraceInfo[i]['PLAN_TABLE_OUTPUT'];
                if (/(---)+/.test(recordStringVal)) {
                    break;
                }
                record = recordStringVal.split('|');
                record.shift();
                record.pop();
                values.push(record);
            }
        } catch (e) {
            // catch failure
            return {};
        }
        return {
            fields: fields,
            values: values
        };
    }

    function getExplain(execute, context, sql, callback) {
        if (!callback) {
            callback = sql;
            sql = context
            context = null;
        }

        execute.call(context, 'EXPLAIN PLAN FOR ' + sql, [], function(error) {
            if (error) {
                return callback(error);
            }
            execute.call(context, 'SELECT * FROM TABLE(DBMS_XPLAN.DISPLAY)', [], function(error, explain) {
                if (error) {
                    return callback(error);
                }
                callback(null, explain);
            });
        });
    }
};