'use strict';
var Segment = require('./trace/segment');

function Trace(action) {
    this.init(action);
}

Trace.prototype.init = function(action) {
    if (!action) {
        throw new Error('All traces must be associated with a action.');
    }
    this.action = action;
    this.recorders = [];
    var segment_info = {
        metric_name: "ROOT",
        call_url: "",
        call_count: 1,
        class_name: "nodejs",
        method_name: "execute",
        params: {}
    };
    this.root = new Segment(this, segment_info);
    this.custom = {};
    this.intrinsics = {};
    this.parameters = {};
    return this;
};

Trace.prototype.end = function end() {
    this.root.end();
    this.record();
};

Trace.prototype.addRecorder = function addRecorder(recorder) {
    this.recorders.push(recorder);
};

Trace.prototype.record = function record() {
    var name = this.action.name;
    this.recorders.forEach(function cb_forEach(recorder) {
        recorder(name);
    }.bind(this));
};

Trace.prototype.add = function add(childName, callback) {
    return this.root.add(childName, callback);
};

Trace.prototype.setDurationInMillis = function setDurationInMillis(duration, startTimeInMillis) {
    this.root.setDurationInMillis(duration, startTimeInMillis);
};

Trace.prototype.getDurationInMillis = function getDurationInMillis() {
    return this.root.getDurationInMillis();
};

Trace.prototype.getExclusiveDurationInMillis = function getExclusiveDurationInMillis() {
    return this.root.getExclusiveDurationInMillis();
};

Trace.prototype.toJSON = function toJSON() {
    var rootNode = [
        Math.round(this.root.timer.start * 0.001),
        this.parameters,
        this.custom,
        this.root.toJSON()
    ];
    var action = this.action;
    var json = [
        Math.round(this.root.timer.start * 0.001),
        Math.round(this.getDurationInMillis()),
        action.name,
        action.url,
        JSON.stringify(rootNode)
    ];
    if (action.agent.config.cross_track()) {
        json.push(action.trans ? action.trans.trans_id : action.id);
        json.push(action.id);
    }
    json.push(action.error ? 1 : 0);
    json.push(action.exceptions.length);
    return json;
};

function calc_duration(pice_array) {
    function merge_data(s, t) {
        if (s[1] < t[0] || t[1] < s[0]) {
            return false;
        }
        if (s[0] < t[0]) {
            t[0] = s[0];
        }
        if (t[1] < s[1]) {
            t[1] = s[1];
        }
        return true;
    }
    do {
        var merged = false;
        for (var i = 0; i < pice_array.length; i++) {
            var top = pice_array[i];
            for (var j = 0; j < pice_array.length; j++) {
                if (j == i) continue;
                if (merge_data(top, pice_array[j])) {
                    merged = true;
                    pice_array.splice(i, 1);
                    break;
                }
            }
            if (merged) break;
        }
    } while (merged);
    var ret = 0;
    for (var i = 0; i < pice_array.length; i++) {
        top = pice_array[i];
        ret += top[1] - top[0];
    }
    return ret;
}

//Trace.prototype.pice_duration = calc_duration;
Trace.prototype.getTraceDurations = function() {
    var workSet = {
        property: {
            MongoDB: 'mon',
            Redis: 'rds',
            Database: 'db',
            Memcached: 'mc',
            External: 'ex'
        },
        values: {} //property:[[start,end],[start,end],.....]
    };
    if (this.root) {
        this.root.getTraceDurations(workSet);
    }
    var result = {};
    for (var k in workSet.values) {
        result[k] = calc_duration(workSet.values[k]);
    }
    var sum = [];
    for (var k in workSet.values) {
        sum = sum.concat(workSet.values[k]);
    }
    result.svc = calc_duration(sum);
    return result;
};

module.exports = Trace;