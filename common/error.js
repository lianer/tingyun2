'use strict';

var util = require('util');

var urltils = require('../util/urltils');
var _util = require('../util/util');
var logger = require('../util/logger').child('common.error');

var MAX_TRACE = 20;
var ALL_MAX_TRACE = 100;

function createErrorTrace(action, exception, customParameters, config, captureParams) {
    var timestamp = (new Date()).getTime() * 0.001;
    var name = action.name || 'WebAction/Uri/*';
    var message = '';
    var type = 'Error';
    var params = {
        params: {},
        requestParams: {},
        stacktrace: {}
    };
    var statusCode = action.statusCode;
    var url = action.url;

    if (typeof exception === 'string') {
        message = exception;
    } else if (exception) {
        message = exception.message || '';
        type = _util.getErrorClassName(exception);
    } else if (statusCode && urltils.errorMatch(config, statusCode)) {
        message = util.format('HttpError %s', statusCode);
    }

    if (captureParams) {
        var custom = action.getTrace().custom;
        Object.keys(custom).forEach(function(param) {
            params.params[param] = custom[param];
        });

        if (config.capture_params) {
            var reqParams = action.getTrace().parameters;
            var urlParams = urltils.parseParameters(url);

            config.ignored_params.forEach(function ignoreParamsFilter(k) {
                delete urlParams[k];
                delete reqParams[k];
            });

            Object.keys(urlParams).forEach(function(param) {
                params.requestParams[param] = urlParams[param];
            });

            Object.keys(reqParams).forEach(function(param) {
                params.requestParams[param] = reqParams[param];
            });
        }

        if (customParameters) {
            var ignored = config.ignored_params || [];
            Object.keys(customParameters).forEach(function customParametersFilter(param) {
                if (ignored.indexOf(param) === -1) {
                    params.params[param] = customParameters[param];
                }
            });
        }
    }

    //error trace needs to capture parameters, exception trace only need to capture parameters when `stack_enabled` switch is enabled.
    if (captureParams || config.exception && config.exception.stack_enabled) {
        var stack = exception && exception.stack;
        if (stack) {
            params.stacktrace = ('' + stack).split(/[\n\r]/g);
        }
    }

    return [
        timestamp,
        name,
        captureParams ? (statusCode || 0) : 0,
        type,
        message,
        1,
        url,
        JSON.stringify(params),
        action.id
    ];
}

function ErrorTracer(config) {
    this.config = config;
    this.errors = {};
    this.externalErrors = [];
    this.exceptions = {};
    this.allTraceCount = 0;
}

ErrorTracer.prototype.onActionFinished = function onActionFinished(action, metrics) {
    if (!action) {
        return logger.error('Error collector requires action context!');
    }
    if (!metrics) {
        return logger.error('Error collector requires metrics!');
    }
    var name = action.name;
    var error = action.error;

    if (urltils.errorMatch(this.config, action.statusCode) || action.forceError) {
        metrics.getMetric('Errors/Count/All').incrementCallCount(1);
        metrics.getMetric('Errors/Count/AllWeb').incrementCallCount(1);
        metrics.getMetric(util.format('Errors/Count/%s', name)).incrementCallCount(1);

        if (!error) {
            error = action.error = action.exceptions.pop();
            if (!error) {
                error = action.error = new Error('HttpError ' + action.statusCode);
            }
        }

        var errorTrace;
        if (this.canAddTrace(name, true)) {
            errorTrace = createErrorTrace(action, error, null, this.config, true);
            (this.errors[name] = this.errors[name] || []).push(errorTrace);
        }

        var errorClassName = errorTrace ? errorTrace[3] : _util.getErrorClassName(error);
        metrics.getMetric(util.format('Errors/Type:%s/%s', errorClassName, name)).incrementCallCount(1);

        var rootSegment = action.getTrace().root;
        var exceptions = rootSegment.parameters.exception = rootSegment.parameters.exception || [];
        exceptions.push({
            message: error.message,
            class: errorClassName,
            stacktrace: error.stack && error.stack.split('\n')
        });
        error = null; // can not set action.error = null, affecting in counting error.
    }
    if (error) {
        action.addExceptions(error);
        action.error = null;
    }
    this.addExceptions(action, metrics);
};

ErrorTracer.prototype.canAddTrace = function canAddTrace(action, isErrorTrace) {
    if (this.allTraceCount > ALL_MAX_TRACE) {
        logger.debug('exceed max trace count, ignore trace recording!');
        return false;
    }
    var name = typeof action === 'string' ? action : action.name;
    var errorTraceCount = (this.errors[name] || []).length;
    var exceptionTraceCount = (this.exceptions[name] || []).length;
    if ((errorTraceCount + exceptionTraceCount) < MAX_TRACE) {
        this.allTraceCount++;
        return true;
    }
    if (isErrorTrace && errorTraceCount < MAX_TRACE) {
        this.allTraceCount++;
        return true;
    }
    return false;
};

ErrorTracer.prototype.addExceptions = function addExceptions(action, metrics) {
    if (!action) {
        return logger.error('Exception collector requires action context!');
    }
    var name = (action.name || (action.statusCode + ''));
    var exceptions = action.exceptions;
    var length = exceptions && exceptions.length;
    if (!length) {
        return;
    }
    for (var i = 0; i < length; i++) {
        metrics.getMetric('Exception/Count/All').incrementCallCount(1);
        metrics.getMetric('Exception/Count/AllWeb').incrementCallCount(1);
        metrics.getMetric(util.format('Exception/Count/%s', name)).incrementCallCount(1);

        var exceptionTrace;
        if (this.canAddTrace(action)) {
            exceptionTrace = createErrorTrace(action, exceptions[i], null, this.config);
            (this.exceptions[name] = this.exceptions[name] || []).push(exceptionTrace);
        }

        if (exceptionTrace) {
            metrics.getMetric(util.format('Exception/Type:%s/%s', exceptionTrace[3], name)).incrementCallCount(1);
        } else {
            metrics.getMetric(util.format('Exception/Type:%s/%s', _util.getErrorClassName(exceptions[i]), name)).incrementCallCount(1);
        }
    }
};

ErrorTracer.prototype.addExternal = function addExternal(segment, metricName, error) {
    var action = segment.trace.action;
    var res = segment.externalResponse;
    if (!this.config.error_collector || !this.config.error_collector.enabled) {
        return;
    }
    if (this.externalErrors.length < MAX_TRACE) {
        var timestamp = Math.round((new Date()).getTime() * 0.001);
        var statusCode = res.statusCode;
        var className = 'Error';
        var stacktrace = [];
        if (error) {
            className = _util.getErrorClassName(error);
            stacktrace = error.stack ? error.stack.split(/[\n\r]/g) : stacktrace;
        }
        var params = {
            params: {
                threadName: '',
                httpStatus: res.statusCode
            },
            requestParams: res.requestParams || {},
            stacktrace: stacktrace
        };
        var errorConstruct = [timestamp, metricName, statusCode, className, 1, action.name, JSON.stringify(params)];
        this.externalErrors.push(errorConstruct);
    } else {
        logger.verbose("Already have %d errors to send, discard!", MAX_TRACE);
    }
};

ErrorTracer.prototype.getErrorTraces = function getErrorTraces() {
    var result = [];
    for (var action in this.errors) {
        result = result.concat(this.errors[action]);
    }
    return result;
};

ErrorTracer.prototype.getExceptionTraces = function getExceptionTraces() {
    var result = [];
    for (var action in this.exceptions) {
        result = result.concat(this.exceptions[action]);
    }
    return result;
};

ErrorTracer.prototype.getExternalTraces = function getExternalTraces() {
    return this.externalErrors;
};

ErrorTracer.prototype.merge = function merge(errors, exceptions, externalErrors) {
    if (this.allTraceCount > ALL_MAX_TRACE) {
        logger.debug('exceed max trace count, no merging!');
        return false;
    }

    var self = this;

    errors = errors || [];
    exceptions = exceptions || [];
    externalErrors = externalErrors || [];

    errors.forEach(function(error) {
        var name = error[1];
        if (self.canAddTrace(name, true)) {
            (self.errors[name] = self.errors[name] || []).push(error);
        }
    });

    exceptions.forEach(function(exception) {
        var name = exception[1];
        if (self.canAddTrace(name)) {
            (self.exceptions[name] = self.exceptions[name] || []).push(exception);
        }
    });

    if (externalErrors.length && this.externalErrors.length < MAX_TRACE) {
        this.externalErrors = this.externalErrors.concat(externalErrors);
    }
};

module.exports = ErrorTracer;