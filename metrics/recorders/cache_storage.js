'use strict';
var util = require('util');

module.exports = function init(name) {
    return function record(segment, scope) {
        var host = segment.host || 'Unknown';
        var port = segment.port === 0 ? 0 : (segment.port || 'Unknown');
        var hostPort = util.format('%s:%s', host, port);

        var operation = segment.name;
        if (operation && name === 'Memcached') {
            operation = operation.replace('NULL', hostPort);
        }

        var action = segment.trace.action;
        var duration = segment.getDurationInMillis();
        var exclusive = segment.getExclusiveDurationInMillis();
        if (scope) {
            action.measure(operation, scope, duration, exclusive);
        }
        action.measure(operation, null, duration, exclusive);
        var template = '%s/%s/%s'; // scope id/category id/metric
        action.measure(util.format(template, name, hostPort, 'All'), null, duration, exclusive);
        action.measure(util.format(template, name, 'NULL', (action.isWeb() ? 'AllWeb' : 'AllBackground')), null, duration, exclusive);
        action.measure(util.format(template, name, 'NULL', 'All'), null, duration, exclusive);
    }
}