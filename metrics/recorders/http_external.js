'use strict';

var logger = require('../../util/logger').child('metrics.recorders.http_external');
var _util = require('../../util/util');
var fmt = require('util').format;

function noop() {}

function recordExternal(host, library) {
    if (!host) {
        logger.debug('External no request url');
        return noop;
    }
    return function cls_recordExternal(segment, scope) {
        var duration = segment.getDurationInMillis();
        var exclusive = segment.getExclusiveDurationInMillis();
        var action = segment.trace.action;
        if (!action) {
            return logger.debug('action context is null when ending external request.');
        }

        var metricPartial = escape(host) + '/' + library;
        var metricName = 'External/' + metricPartial;
        var errorMetricName = metricName;

        var txData = segment.parameters && segment.parameters.txData;
        var txExist = !!(txData && txData.id);
        var backendDuration = 0;
        if (scope) {
            action.measure(metricName, scope, duration, exclusive);
            if (txExist) {
                var time = txData.time;
                backendDuration = (time.qu || 0) + (time.duration || 0);
                if (time.qu >= 0 && time.qu <= (duration - time.duration)) {
                    var name = fmt('%s/%s/%s', 'ExternalTransaction', escape(host), escape(txData.id) + '%2F' + txData.action);
                    action.measure(name, scope, duration, backendDuration);
                } else {
                    logger.debug('validation failed, time does not match.');
                    action.measure(metricName, scope, duration, exclusive);
                }
            }
        }

        action.measure(metricName, null, duration, exclusive);
        action.measure(action.isWeb() ? 'External/NULL/AllWeb' : 'External/NULL/AllBackground', null, duration, exclusive);
        action.measure('External/' + escape(host) + '/All', null, duration, exclusive);
        action.measure('External/NULL/All', null, duration, exclusive);
        if (segment.externalResponse) {
            action.metrics.getMetric('Errors/Count/' + errorMetricName).incrementCallCount(1);
            action.metrics.getMetric('Errors/Type:' + segment.externalResponse.statusCode + '/' + errorMetricName).incrementCallCount(1);
            var error = segment.externalResponse.error;
            action.agent.errors.addExternal(segment, errorMetricName, error);
            error.message = fmt('%s %s', error.message, host);
            error.name = error.name || 'External Error';
            var exceptions = segment.parameters.exception = segment.parameters.exception || [];
            exceptions.push({
                message: error.message,
                class: _util.getErrorClassName(error),
                stacktrace: error.stack && error.stack.split('\n')
            });
            action.addExceptions(error);
            segment.externalResponse = null; //release
        }
        if (txExist) {
            var sec_id = escape(txData.id);
            var tokIndex = host.indexOf('://');
            var protocol = (tokIndex > 0) ? host.slice(0, tokIndex) : 'http';
            action.measure('ExternalTransaction/NULL/' + sec_id, null, backendDuration, backendDuration);
            action.measure('ExternalTransaction/' + protocol + '/' + sec_id, null, duration, exclusive);
            action.measure('ExternalTransaction/' + protocol + ':async/' + sec_id, null, duration, exclusive);
        }
    }
}

function escape(str) {
    if (!str) {
        return '';
    }
    return str.replace(/\//g, "%2F");
}

module.exports = recordExternal;