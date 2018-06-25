'use strict';

var logger = require('../../util/logger').child('metrics.recorders.http');

function recordWeb(segment, scope) {
    // in web metrics, scope is required
    if (!scope) {
        return;
    }
    var duration = segment.getDurationInMillis();
    var exclusive = segment.getExclusiveDurationInMillis();
    var action = segment.trace.action;
    var agent = action.agent;
    var config = agent.config;

    if (config.quantile) {
        logger.debug('action %s duration is: %s', scope, duration);
        agent.quantile.add(scope, duration);
    }

    action.measureAction(scope, null, duration, exclusive);
    action.setApdex('Apdex/' + segment.partialName, duration, config.web_actions_apdex[scope]);
}

module.exports = recordWeb;