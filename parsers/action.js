'use strict';
var urltils = require('../util/urltils.js');
var _util = require('../util/util.js');
var Metrics = require('../metrics/metrics.js');
var Timer = require('../util/timer.js');
var Trace = require('../metrics/trace.js');
var logger = require('../util/logger').child('parsers.action');
var common = require('./common');

var last_time = Date.now();
var last_num = 0;

function get_id(preid) {
    var top_time = Date.now();
    last_num = (top_time == last_time) ? last_num + 1 : 0;
    last_time = top_time;
    var rand_id = last_time.toString(32) + last_num.toString(32);
    if (preid && typeof preid === 'number') {
        rand_id = preid.toString(32) + rand_id;
    }
    return '0000000000000000'.slice(0, 16 - rand_id.length) + rand_id;
}

function Action(agent) {
    this.agent = agent;
    this.init();
}

Action.prototype.init = function() {
    var agent = this.agent;

    Object.defineProperty(this, 'finalName', {
        get: function() {
            return this.name && this.name.replace(/\//g, '%2F') || '';
        }
    });

    this.timer = new Timer();
    this.timer.begin();
    this.metrics = new Metrics(agent.config.apdex_t, agent.mapper, agent.metricNameNormalizer);

    this.id = get_id(agent.config.applicationId);
    this.name = null;
    this.partialName = null;

    this.error = null;
    this.exceptions = [];
    this.forceError = false;
    this.errorType = {};

    this.verb = null;
    this.url = null;
    this.originalUrl = null;
    this.isStaticAsset = false;
    this.query = null;
    this.body = null;
    this.headers = null;

    this.statusCode = null;

    this.trace = null;
    this.forceIgnore = null;
    this.ignore = false;

    this.webSegment = null;
    this.bgSegment = null;
    this.customRootSegment = null;
    this.thrift = {};
    this.applyCustomeActionName = false;

    this.consumer = null;
    this.embedded = false;

    this.webActionNamer = null;
};

Action.prototype.reset = function() {
    this.init();
};

Action.prototype.setError = function(error) {
    if (!error) {
        return;
    }
    if (this.forceError && this.error) {
        logger.debug('error already set by user, can not overwrite, store it as exception!');
        this.addExceptions(error);
    } else {
        if (this.error) {
            this.addExceptions(this.error);
        }
        this.error = error;
    }
};

Action.prototype.addExceptions = function(exception) {
    if (!exception) {
        return;
    }
    var typeName = _util.getErrorClassName(exception);
    var typeCount = Object.keys(this.errorType);
    if (typeCount >= (this.agent.config['exception.type_max'] || 500) && (!this.errorType[typeName])) {
        exception.code = 'All Other Traffic';
    } else {
        this.errorType[typeName] = true;
    }
    this.exceptions.push(exception);
};

Action.prototype.getTrace = function getTrace() {
    if (!this.trace) {
        this.trace = new Trace(this);
    }
    return this.trace;
};

Action.prototype.isWeb = function isWeb() {
    return this.url ? true : false;
};

Action.prototype.isActive = function isActive() {
    return this.timer.isActive();
};

var MAX_ACTION_TIME = 2 * 60 * 1000 * 1000;
Action.prototype.passDeadline = function passDeadline() {
    return this.timer.getDurationInMillis() >= MAX_ACTION_TIME;
};

Action.prototype.end = function end() {
    if (!this.timer.isActive()) {
        return;
    }
    if (typeof this.block_time !== 'undefined') {
        this.metrics.measureMilliseconds('WebFrontend/NULL/QueueTime', null, this.block_time, 0);
    }
    this.timer.end();
    if (this.trace) {
        this.trace.end();
    }
    this.agent.emit('ActionEnd', this);
};

Action.prototype.applyUserNamingRules = function applyUserNamingRules(requestUrl) {
    var normalizer = this.agent.userNormalizer;
    if (normalizer.isIgnored(requestUrl)) {
        this.ignore = true;
    }
    if (normalizer.isNormalized(requestUrl)) {
        this.setPartialName('NormalizedUri' + normalizer.normalize(requestUrl));
    }
};

Action.prototype.setPartialName = function setPartialName(name) {
    this.partialName = name;
};

Action.prototype.setName = function setName(statusCode) {
    this.statusCode = statusCode;
    this.applyUserNamingRules(this.url);
    var normalizer = this.agent.urlNormalizer;
    if (normalizer.isIgnored(this.url)) {
        this.ignore = true;
    }
    if (!this.partialName) {
        this.setPartialName(normalizer.normalize(this.url, this));
    }
    var actionNamer = this.webActionNamer;
    if (actionNamer && !this.isStaticAsset) {
        if (actionNamer.match()) {
            var name = actionNamer.split().getName();
            //override webaction autoName.
            name && this.setPartialName(name);
        }
    }

    var webActionUriParamsNamingRules = this.agent.config.webActionUriParamsNamingRules;
    if (webActionUriParamsNamingRules && !this.isStaticAsset) {
        var nameByUriParams = common.namingByUriPrams(this.url, this.query, this.body, this.headers, webActionUriParamsNamingRules);
        if (nameByUriParams) {
            this.setPartialName(nameByUriParams);
        }
    }

    normalizer = this.agent.actionNameNormalizer;
    var fullName = 'WebAction/' + this.partialName;
    if (normalizer.isIgnored(fullName)) {
        this.ignore = true;
    }
    if (!this.applyCustomeActionName) {
        this.name = normalizer.normalize(fullName);
    }
    if (this.forceIgnore === true || this.forceIgnore === false) {
        this.ignore = this.forceIgnore;
    }
};

Action.prototype.setCustom = function setCustom(header, _httpStatus) {
    var trace = this.getTrace();
    trace.custom = {
        referer: ((header && header.referer) ? header.referer : ""),
        httpStatus: _httpStatus,
        'user-agent': header['user-agent'] || ''
    };
    return trace.custom;
};

Action.prototype.measureAction = function measure(name, scope, duration, exclusive) {
    this.metrics.measureMilliseconds(name, scope, duration, exclusive, true);
};

Action.prototype.measure = function measure(name, scope, duration, exclusive) {
    this.metrics.measureMilliseconds(name, scope, duration, exclusive);
};

Action.prototype.setApdex = function setApdex(name, duration, apdex_t) {
    var apdex = this.metrics.ApdexMetric(name, apdex_t);
    if (urltils.errorMatch(this.agent.config, this.statusCode)) {
        apdex.incFrustrating();
    } else {
        apdex.add(duration);
    }
};

Action.prototype.get_name = function() {
    return this.agent.actionNameNormalizer.normalize('WebAction/' + (this.partialName ? this.partialName : this.agent.urlNormalizer.normalize(this.url)));
};

Action.prototype.getTraceDurations = function() {
    var trace = this.getTrace();
    var result = trace.getTraceDurations();
    var pice_array = [];
    //添加block, queuetime
    result.qu = (typeof this.block_time !== 'undefined') ? this.block_time : 0;
    result.duration = trace.getDurationInMillis();
    result.code = (result.svc < result.duration) ? (result.duration - result.svc) : 0;
    delete result.svc;
    var id = this.agent.config.transaction_tracer.tingyunIdSecret;
    if (id) {
        id = id.slice(id.indexOf('|') + 1);
    }
    // round result.
    for (var key in result) {
        if (typeof result[key] === 'number') {
            result[key] = Math.round(result[key]);
        }
    }
    var ret = {
        id: id,
        action: this.get_name(),
        trId: this.id,
        time: result
    };
    return JSON.stringify(ret);
};

module.exports = Action;