'use strict';

var Stats = require('../common/stats.js');
var ApdexStats = require('../common/stats/apdex.js');
var MetricsFormat = require('./format.js')
var util = require('../util/util');

function Metrics(apdex_t, mapper, normalizer) {
    if (typeof apdex_t !== 'number') {
        throw new Error("metrics must be created with apdex_t");
    }
    if (!mapper) {
        throw new Error("metrics must be created with a mapper");
    }
    if (!normalizer) {
        throw new Error("metrics must be created with a name normalizer");
    }
    this.started = Date.now();
    this.apdex_t = apdex_t;
    this.mapper = mapper;
    this.normalizer = normalizer;
    this.components = {}; // {parent : {name : stats}}
    this.apdex = {};
    this.actions = {};
    this.general = {};
    this.errors = {};
    this.exceptions = {};
}

Metrics.prototype.measureMilliseconds = function measureMilliseconds(name, scope, duration, exclusive, isAction) {
    var stats = this.getMetric(name, scope);
    if (isAction) {
        stats.add1(duration, exclusive);
    } else {
        stats.add(duration, exclusive);
    }
    return stats;
};

Metrics.prototype.measureByBytes = function measureBytes(name, size) {
    var stats = this.getMetric(name);
    stats.recordValueByBytes(size);
    return stats;
};

Metrics.prototype.measureBytes = function measureBytes(name, size) {
    var stats = this.getMetric(name);
    stats.recordValueInBytes(size);
    return stats;
};

function fix_trace_name(name) {
    if (typeof name === 'string') {
        return name;
    }
    return '__trace_cross_' + name[0] + name[1] + name[2];
}

Metrics.prototype.getMetric = function getMetric(name, parent, externalStatus) {
    if (!name) {
        throw new Error('Metrics must be named');
    }
    var fix_name = fix_trace_name(name);
    var container = this._container(fix_name, parent);
    if (!container[fix_name]) {
        container[fix_name] = new Stats();
    }
    container[fix_name].name = name;
    return container[fix_name];
};

Metrics.prototype.ApdexMetric = function ApdexMetric(name, apdex_t) {
    if (!this.apdex[name]) {
        this.apdex[name] = new ApdexStats(apdex_t > 0 ? apdex_t : this.apdex_t);
    }
    return this.apdex[name];
};

Metrics.prototype.read = function read(agent) {
    var config = agent.config;
    var metricsData = {
        type: "perfMetrics",
        timeFrom: Math.round(this.started * 0.001),
        timeTo: Math.round(Date.now() * 0.001),
        interval: config.dataSentInterval,
        config: {},
        actions: new MetricsFormat(this.actions, this.mapper, 'action', agent),
        apdex: new MetricsFormat(this.apdex, this.mapper),
        components: new MetricsFormat(this.components, this.mapper, 'components'),
        general: new MetricsFormat(this.general, this.mapper),
        errors: new MetricsFormat(this.errors, this.mapper),
        exceptions: new MetricsFormat(this.exceptions, this.mapper)
    };
    if (this.actions && !util.isEmptyObject(this.actions) && config.quantile) {
        metricsData.config['nbs.quantile'] = JSON.stringify(config.quantile.map(function(num) {
            return num * 100;
        }));
    }
    return metricsData;
};

Metrics.prototype.merge = function merge(other) {
    this.started = Math.min(this.started, other.started);
    for (var name in other.apdex) {
        if (this.apdex[name]) {
            this.apdex[name].merge(other.apdex[name]);
        } else {
            this.apdex[name] = other.apdex[name];
        }
    }
    for (var name in other.actions) {
        if (this.actions[name]) {
            this.actions[name].merge(other.actions[name]);
        } else {
            this.actions[name] = other.actions[name];
        }
    }
    for (var name in other.general) {
        if (this.general[name]) {
            this.general[name].merge(other.general[name]);
        } else {
            this.general[name] = other.general[name];
        }
    }
    for (var name in other.errors) {
        if (this.errors[name]) {
            this.errors[name].merge(other.errors[name]);
        } else {
            this.errors[name] = other.errors[name];
        }
    }
    for (var name in other.exceptions) {
        if (this.exceptions[name]) {
            this.exceptions[name].merge(other.exceptions[name]);
        } else {
            this.exceptions[name] = other.exceptions[name];
        }
    }
    for (var parent in other.components) {
        for (var name in other.components[parent]) {
            if (other.components[parent][name]) {
                var resolved = this._container(name, parent);
                if (resolved[name]) {
                    resolved[name].merge(other.components[parent][name]);
                } else {
                    resolved[name] = other.components[parent][name];
                }
            }
        }
    }
};

Metrics.prototype._container = function _container(name, parent) {
    if (parent) {
        if (!this.components[parent]) {
            this.components[parent] = {};
        }
        return this.components[parent];
    }
    if (name.indexOf("Apdex") == 0) {
        return this.apdex;
    }
    if (name.indexOf("WebAction") == 0) {
        return this.actions;
    }
    if (name.indexOf("BackgroundAction") == 0) {
        return this.actions;
    }
    if (name.indexOf("Errors") == 0) {
        return this.errors;
    }
    if (name.indexOf("Exception") == 0) {
        return this.exceptions;
    }
    return this.general;
};

module.exports = Metrics;