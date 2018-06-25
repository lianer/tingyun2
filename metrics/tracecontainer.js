'use strict';
var extention = require('../ext/ext_main');
var logger = require('../util/logger').child('metrics.tracecontainer');

function TraceContainner(config) {
    if (!config) {
        throw new Error("Config Info Needed.");
    }
    this.config = config;
    this.top_n = (config.action_tracer && config.action_tracer.top_n) ? config.action_tracer.top_n : 1;
    this.clear();
}

TraceContainner.prototype.clear = function clear() {
    this.trace_map = {};
    this.min_duration = 0;
    this.trace_count = 0;
    this.sql_map = {};
};

function sort(trace, asc) {
    return trace.sort(function(a, b) {
        return asc ? (a[0] - b[0]) : (b[0] - a[0]);
    });
}

TraceContainner.prototype.insert = function add(name, duration, apdex_t, trace, force) {
    if (force) {
        if (this.trace_count >= this.top_n) {
            return;
        }
    } else {
        if (this.trace_count >= this.top_n && duration <= this.min_duration) {
            return;
        }
        var config = this.config.action_tracer;
        //配置项里如果没有action_threshold,则取apdex_t*4代替
        var limit = (typeof config.action_threshold === 'number') ? config.action_threshold : apdex_t * 4;
        //action处理时间在可接受范围
        if (duration <= limit) {
            return;
        }
    }
    var trace_info = this.trace_map[name];
    if (trace_info) {
        var sameActionCount = this.top_n > 10 ? 10 : this.top_n;
        if (trace_info.length >= sameActionCount) {
            if (trace_info[0][0] < duration) {
                trace_info.shift();
                trace_info.push([duration, trace]);
                trace_info = sort(trace_info, true);
            }
        } else {
            trace_info.push([duration, trace]);
            trace_info = sort(trace_info, true);
        }
    } else {
        this.trace_map[name] = [];
        trace_info = [duration, trace];
        this.trace_map[name].push(trace_info);
        this.trace_count++;
        if (this.trace_count > this.top_n) {
            //删除duration最小的action
            for (var key in this.trace_map) {
                if (this.trace_map[key][0][0] == this.min_duration) {
                    delete this.trace_map[key];
                    break;
                }
            }
        }
    }
    for (var key in this.trace_map) {
        this.min_duration = this.trace_map[key][0][0];
        break;
    }
    for (var key in this.trace_map) {
        var duration = this.trace_map[key][0][0];
        if (duration < this.min_duration) {
            this.min_duration = duration;
        }
    }
};

TraceContainner.prototype.add = function add(action) {
    if (this.config.action_tracer && this.config.action_tracer.enabled && action && action.metrics) {
        var trace = action.getTrace();
        var duration = trace.getDurationInMillis();
        this.insert(action.name, duration, action.metrics.apdex_t, trace, action.forceActionTrace);
    }
    this._add_sql(action);
};

function obfuscate_sql(sql, obfuscated_sql_fields) {
    sql = sql.replace(/\`([^\`]*)\`/g, '$1');
    sql = sql.replace(/\"([^\"]*)\"/g, '$1');
    if (obfuscated_sql_fields && typeof obfuscated_sql_fields === 'string' && obfuscated_sql_fields.length > 0) {
        sql = extention.confusion(sql, obfuscated_sql_fields);
    } else {
        sql = extention.confusion(sql);
    }
    return sql;
}

function metric_add(metric1, metric2) {
    if (metric1.count == 0) {
        metric1.max = metric2.max;
        metric1.min = metric2.min;
    } else {
        if (metric2.max > metric1.max) {
            metric1.max = metric2.max;
        }
        if (metric2.min < metric1.min) {
            metric1.min = metric2.min;
        }
    }
    metric1.count += metric2.count;
    metric1.sum += metric2.sum;
}

TraceContainner.prototype._add_sql = function _add_sql(action) {
    var trace;
    if (!action || !(trace = action.getTrace())) {
        return;
    }
    var self = this;
    trace.root.peek(function on_sql_metric(segment) {
        if (!action.name) {
            return logger.error('action name is not properly set.(action.id:%s, action.url:%s)', action.id, action.url);
        }
        if (!self.sql_map[action.name]) {
            self.sql_map[action.name] = {};
        }
        var action_info = self.sql_map[action.name];
        var sql;
        var actionTracer = self.config.action_tracer;
        if (actionTracer.record_sql === 'obfuscated') {
            sql = obfuscate_sql(segment.segment_data.sql, actionTracer.obfuscated_sql_fields);
        } else {
            sql = segment.segment_data.sql;
        }
        if (!action_info[sql]) {
            action_info[sql] = {
                duration: -1,
                metric: {
                    count: 0,
                    sum: 0,
                    max: 0,
                    min: 0
                }
            };
        }
        var sql_info = action_info[sql];
        if (segment.peeked) {
            if (segment.segment_data.explainPlan) {
                sql_info.explainPlan = segment.segment_data.explainPlan;
            }
            return;
        }
        metric_add(sql_info.metric, segment.segment_data.metric);
        sql_info.start = Math.round(segment.timer.start * 0.001);
        sql_info.name = segment.name;
        sql_info.url = action.url;
        var sql_duration = segment.getDurationInMillis();
        if (segment.segment_data.stack && segment.segment_data.stack.length && sql_duration > sql_info.duration) {
            sql_info.duration = sql_duration;
            sql_info.stack = segment.segment_data.stack;
        }
        if (segment.segment_data.explainPlan) {
            sql_info.explainPlan = segment.segment_data.explainPlan;
        }
        segment.peeked = true;
    });
};

TraceContainner.prototype.sql_trace = function sql_trace() {
    var ret = [];
    for (var key in this.sql_map) {
        var action_info = this.sql_map[key];
        for (var sql in action_info) {
            var sql_info = action_info[sql];
            var sql_params = {};
            if (sql_info.stack) {
                sql_params.stacktrace = sql_info.stack;
            }
            if (sql_info.explainPlan) {
                sql_params.explainPlan = sql_info.explainPlan;
            }
            ret.push([
                sql_info.start,
                key,
                sql_info.name,
                sql_info.url,
                sql,
                sql_info.metric.count,
                Math.round(sql_info.metric.sum),
                Math.round(sql_info.metric.max),
                Math.round(sql_info.metric.min),
                JSON.stringify(sql_params)
            ]);
        }
    }
    return ret;
};

TraceContainner.prototype.action_trace = function action_trace() {
    var ret = [];
    for (var key in this.trace_map) {
        var trace = this.trace_map[key];
        trace && trace.forEach(function(item) {
            ret.push(item[1].toJSON());
        });
    }
    return ret;
};

TraceContainner.prototype.trace_size = function trace_size() {
    return this.trace_count;
};

module.exports = TraceContainner;