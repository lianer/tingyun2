'use strict';

var util = require('util');
var urltils = require('../../util/urltils.js');
var sumChildren = require('../../util/sum-children');
var Timer = require('../../util/timer');

function TraceSegment(trace, seg_info, recorder) {
    if (!trace) {
        throw new Error('Trace segments must be bound to a action trace.');
    }
    if (!seg_info) {
        throw new Error('Trace segments must be named.');
    }

    this.trace = trace;
    this.segment_data = seg_info;
    this.name = seg_info.metric_name;
    if (!this.name) {
        throw new Error('Name not set.');
    }
    if (recorder) {
        this.trace.addRecorder(recorder.bind(null, this));
    }

    this.parameters = {};
    this.children = [];

    this.timer = new Timer();
    this.timer.begin();

    // hidden class optimization
    this.partialName = null;
    this.externalResponse = null;
    this._exclusiveDuration = null;
    this.host = null;
    this.port = null;
    this.database = null;
    this.state = 'EXTERNAL';
    this.peeked = false;
}

TraceSegment.prototype.peek = function peek(callback) {
    if (this.segment_data.metric) {
        callback(this);
    }
    for (var i = 0; i < this.children.length; i++) {
        this.children[i].peek(callback);
    }
};

TraceSegment.prototype.moveToCallbackState = function moveToCallbackState() {
    this.state = 'CALLBACK';
};

TraceSegment.prototype.isInCallbackState = function isInCallbackState() {
    return this.state === 'CALLBACK';
};

TraceSegment.prototype.markAsWeb = function markAsWeb(rawURL) {
    var action = this.trace.action;

    // action name and web segment name must match
    this.name = action.name || this.name;
    // partialName is used to name apdex metrics when recording
    this.partialName = action.partialName;

    var config = this.trace.action.agent.config;

    // Copy params object so we can modify it before applying it
    // multiple params places. It eventually runs through copyParameters
    // so I'm not worried about `ignored_params` or `capture_params`.
    var params = util._extend({}, this.parameters);

    // This shouldn't be moved from the segment to the trace, so remove it.
    delete params.real_duration;

    // Because we are assured we have the URL here, lets grab query params. Same
    // as above, about to be run through copyParameters, so opt for the faster
    // object merge/copy.
    util._extend(params, urltils.parseParameters(rawURL));

    urltils.copyParameters(config, params, this.parameters);
    urltils.copyParameters(config, params, this.trace.parameters);
};

TraceSegment.prototype.setName = function(name) {
    if (name) {
        this.segment_data.metric_name = this.name = name;
    }
};

TraceSegment.prototype.touch = function touch() {
    this.timer.touch();
};

TraceSegment.prototype.end = function end(config, sql_trace) {
    //    if (!this.timer.isActive()) return;
    if (this.timer.isActive()) {
        this.timer.end();
    }
    if (config && sql_trace) {
        var curr_duration = this.getDurationInMillis();
        this._metric_add(curr_duration);
        var limit = (typeof config.action_tracer.slow_sql_threshold === 'number') ? config.action_tracer.slow_sql_threshold : config.apdex_t * 4;
        this.segment_data.sql = sql_trace.sql;
        if (limit < curr_duration) {
            this.segment_data.stack = sql_trace.stack;
        }
        if (sql_trace.explainPlan) {
            this.segment_data.explainPlan = sql_trace.explainPlan;
        }
    }
};

TraceSegment.prototype._metric_add = function _metric_add(duration) {
    if (!this.segment_data.metric) {
        this.segment_data.metric = {
            count: 0,
            sum: 0,
            max: 0,
            min: 0
        };
    }
    var metric = this.segment_data.metric;
    if (metric.count == 0) {
        metric.sum = metric.max = metric.min = duration;
    } else {
        metric.sum += duration;
        if (duration < metric.min) {
            metric.min = duration;
        }
        if (metric.max < duration) {
            metric.max = duration;
        }
    }
    metric.count++;
};

TraceSegment.prototype._isEnded = function _isEnded() {
    return !this.timer.isActive();
};

TraceSegment.prototype.add = function add(seg_info, callback) {
    var segment = new TraceSegment(this.trace, seg_info, callback);
    this.children.push(segment);
    return segment;
};

TraceSegment.prototype.setDurationInMillis = function setDurationInMillis(duration, start) {
    this.timer.setDurationInMillis(duration, start);
};

TraceSegment.prototype.getDurationInMillis = function getDurationInMillis() {
    return this.timer.getDurationInMillis();
};

TraceSegment.prototype.getExclusiveDurationInMillis = function getExclusiveDurationInMillis() {
    if (this._exclusiveDuration) {
        return this._exclusiveDuration;
    }
    var total = this.getDurationInMillis();
    var end = this.timer.toRange()[1];
    if (this.children.length > 0) {
        // convert the list of start, duration pairs to start, end pairs
        total -= sumChildren(this._getChildPairs(end));
    }
    return (total < 0) ? 0 : total;
};

TraceSegment.prototype._getChildPairs = function _getChildPairs(end) {
    // quick optimization
    if (this.children.length < 1) {
        return [];
    }
    if (!end) {
        end = Infinity;
    }

    var seed = this.children.map(function cb_map(segment) {
        return segment.timer.toRange();
    });

    return this.children
        .reduce(function cb_reduce(pairs, segment) {
            return pairs.concat(segment._getChildPairs(end));
        }, seed)
        .filter(function cb_filter(pair) {
            return pair[0] < end;
        })
        .map(function cb_map(pair) {
            // FIXME: heuristically limit intervals to the end of the parent segment
            return [pair[0], Math.min(pair[1], end)];
        });
};

TraceSegment.prototype.toJSON = function toJSON() {
    var start = this.timer.startedRelativeTo(this.trace.root.timer);

    return [
        Math.round(start),
        Math.round(start + this.getDurationInMillis()),
        this.segment_data.metric_name,
        this.segment_data.call_url,
        this.segment_data.call_count,
        this.segment_data.class_name,
        this.segment_data.method_name,
        this.parameters,
        this.children.map(function cb_map(child) {
            return child.toJSON();
        })
    ];
};

TraceSegment.prototype.getTraceDurations = function(workset) {
    for (var key in workset.property) {
        if (this.segment_data.metric_name.indexOf(key) == 0) {
            var nm = workset.property[key];
            var start = this.timer.startedRelativeTo(this.trace.root.timer);
            var val = [Math.round(start), Math.round(start + this.getDurationInMillis())];
            if (!workset.values[nm]) {
                workset.values[nm] = [];
            }
            workset.values[nm].push(val);
        }
    }
    for (var i = 0; i < this.children.length; i++) {
        this.children[i].getTraceDurations(workset);
    }
};

module.exports = TraceSegment;