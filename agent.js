'use strict';
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var logger = require('./util/logger.js').child('agent');
var sampler = require('./common/sampler.js');
var ReportServer = require('./server/api.js');
var ErrorTracer = require('./common/error.js');
var Metrics = require('./metrics/metrics.js');
var MetricNormalizer = require('./metrics/normalizer.js');
var NameMap = require('./metrics/mapper.js');
var TraceContainner = require('./metrics/tracecontainer.js');
var QuantileHolder = require('./metrics/quantile-holder.js');

function Agent(config) {
    EventEmitter.call(this);
    if (!config) {
        throw new Error("Agent must be created with a configuration!");
    }
    this.config = config;
    this.config.on('apdex_t', this._on_apdex.bind(this));
    this.config.on('enabled', this.on_enabled.bind(this));
    this.config.on('appSessionKey', this.on_enabled.bind(this));
    this.config.on('dataSentInterval', this._on_interval.bind(this));
    this.environment = require('./metrics/environment');
    this.reportServer = new ReportServer(this);
    // error tracing
    this.errors = new ErrorTracer(this.config);
    this.quantile = new QuantileHolder(this.config);
    // metrics
    this.mapper = new NameMap();
    this.metricNameNormalizer = new MetricNormalizer(this.config, 'metric name');
    this.metrics = new Metrics(this.config.apdex_t, this.mapper, this.metricNameNormalizer);
    // action naming
    this.actionNameNormalizer = new MetricNormalizer(this.config, 'action name');
    this.urlNormalizer = new MetricNormalizer(this.config, 'URL');
    this.urlNormalizer.load(this.config.url_rules);
    // user naming and ignoring rules
    this.userNormalizer = new MetricNormalizer(this.config, 'user');
    this.userNormalizer.loadFromConfig();
    // action traces
    var Tracer = require('./parsers/tracer');
    this.tracer = new Tracer(this);
    this.traces = new TraceContainner(this.config);
    //action 结束时计算action统计信息
    this.on('ActionEnd', this._on_action.bind(this));
}

util.inherits(Agent, EventEmitter);

Agent.prototype.start = function start() {
    var agent = this;

    if (!(this.config.licenseKey)) {
        var err_string = 'License Not Found.';
        logger.error(err_string);
        return err_string;
    }
    sampler.start(agent);
    logger.info("Starting login...");
    this.reportServer.connect(function on_connect(error, config) {
        agent._startTimer(agent.config.dataSentInterval);
    });
    return "success";
};
Agent.prototype.stop = function stop(callback) {
    if (!callback) {
        throw new TypeError("callback required!");
    }
    sampler.stop();
    logger.info("Stopped TingYun for Node.js.");

    function on_stoped(error) {
        callback(error);
    }
    this.reportServer.reset();
    return process.nextTick(on_stoped);
};
Agent.prototype.reconfigure = function reconfigure(configuration) {
    if (!configuration) {
        throw new TypeError("must pass configuration");
    }

    this.config.update(configuration);
};
Agent.prototype.getAction = function getAction() {
    return this.tracer.getAction();
};
Agent.prototype.enabled = function() {
    return this.config.enabled;
};
//apdex_t change notification
Agent.prototype._on_apdex = function _on_apdex(apdex_t) {
    logger.verbose("Server Action Apdex = %s.", apdex_t);
    this.metrics.apdex_t = apdex_t;
};
//anget's enabled switch notification
Agent.prototype.on_enabled = function() {
    if (this.config.enabled === false) {
        logger.warning('agent_enabled has been changed to false, stopping the agent.');
        this.stop(function() {});
    }
};
//send interval change notification
Agent.prototype._on_interval = function _on_interval(interval, callback) {
    if (this.hTimer) {
        this._restart_timer(interval);
    }
    if (callback) {
        process.nextTick(callback);
    }
};
Agent.prototype._restart_timer = function _restart_timer(interval) {
    this._stopTimer();
    this._startTimer(interval);
};
Agent.prototype._stopTimer = function _stopTimer() {
    if (this.hTimer) {
        clearInterval(this.hTimer);
    }
    this.hTimer = undefined;
};
Agent.prototype._startTimer = function _startTimer(interval) {
    var agent = this;
    this.hTimer = setInterval(function() {
        agent._on_timer();
    }, interval * 1000);
    if (this.hTimer.unref) {
        this.hTimer.unref();
    }
};
Agent.prototype._on_timer = function _on_timer() {
    var agent = this;
    this.config.on_timer(function on_check() {
        if (agent.config.stoped && agent.config.enabled) {
            agent.config.enabled = false;
            agent.stop(function on_stop() {});
        }
    });
    if (this.config.stoped) {
        return;
    }
    if (sampler.state === 'stopped') {
        logger.debug("agent restart.")
        sampler.start(this);
    }

    function on_server_return(agent, json) {
        if (json && json.status !== 'success' && json.result && json.result.errorCode) {
            if (json.result.errorCode === 460) { //license key invalid
                agent.stop(function on_stop(cb) {
                    logger.info("tingyun stoped by server code 460.");
                });
            } else { //461 || 462 || 470 || -1 || other
                agent.reportServer.reset();
            }
        }
    }
    var agent = this;

    function on_upload_ret(err, returnd, json) {
        on_server_return(agent, json);
        var code;
        if (err && err.statusCode) {
            code = (err.statusCode - err.statusCode % 100) / 100;
        }
        if (code && (code !== 2 || code !== 5)) {
            agent.reportServer.reset();
        }
    }
    if (!this.reportServer.isConnected()) {
        if (!this.reportServer.connectting()) {
            this.reportServer.connect(function on_connect(err, returnd, json) {
                if (agent.reportServer.isConnected()) {
                    return agent._send_metrics(on_upload_ret);
                }
                on_server_return(agent, json);
            });
        } else {
            logger.warning("send Metrics: in connectting.");
        }
    } else {
        this._send_metrics(on_upload_ret);
    }
};
Agent.prototype._send_metrics = function send_metrics(callback) {
    var agent = this;
    var metrics = this.metrics;
    var payload = [metrics.read(this)];
    this.metrics = new Metrics(this.config.apdex_t, this.mapper, this.metricNameNormalizer);
    var errors = this.errors.getErrorTraces();
    var externalErrors = this.errors.getExternalTraces();
    var exceptions = this.errors.getExceptionTraces();
    this.errors = new ErrorTracer(agent.config);
    if (this.config.error_collector.enabled) {
        if (errors.length) {
            payload.push({
                type: "errorTraceData",
                errors: errors
            });
        }
        if (externalErrors.length) {
            payload.push({
                type: 'externalErrorTraceData',
                errors: externalErrors
            });
        }
        if (exceptions.length) {
            payload.push({
                type: 'exceptionTraceData',
                exceptions: exceptions
            });
        }
    }
    if (this.traces.trace_size() > 0) {
        payload.push({
            type: "actionTraceData",
            actionTraces: this.traces.action_trace()
        });
    }
    var sql_trace = this.traces.sql_trace();
    if (sql_trace.length) {
        payload.push({
            type: "sqlTraceData",
            sqlTraces: sql_trace
        });
    }
    sql_trace = null;
    this.traces.clear();
    this.reportServer.upload(payload, function cb_metricData(error, results, json) {
        if (error) {
            if (typeof agent.retry_count === 'undefined') {
                agent.retry_count = 0;
            }
            if (agent.retry_count < 3 && !results) {
                agent.metrics.merge(metrics);
                agent.errors.merge(errors, exceptions, externalErrors);
                agent.retry_count++;
            } else {
                agent.retry_count = 0;
                agent.reportServer.reset();
            }
        } else {
            if (results && json.status === 'success') {
                agent.mapper.load(results);
            }
            metrics = null;
            errors = null;
        }
        agent.quantile.reset();
        callback.apply(this, arguments);
    });
};
Agent.prototype._on_action = function _on_action(action) {
    if (action.ignore) {
        return logger.verbose("%s %s.", (action.forceIgnore === true) ? "Explicitly ignoring" : "Ignoring", action.name);
    }
    if (action.forceIgnore === false) {
        logger.verbose("Explicitly not ignoring %s.", action.name);
    }
    this.metrics.merge(action.metrics);
    this.errors.onActionFinished(action, this.metrics);
    this.traces.add(action);
};

module.exports = Agent;