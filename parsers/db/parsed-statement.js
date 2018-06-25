'use strict';
var util = require('util');

var UNKNOWN = 'Unknown';

function ParsedStatement(type, operation, model) {
    this.type = type;
    this.operation = operation;
    if (model) {
        var match = (/^`([^`]+)`$/gi).exec(model);
        model = match ? match[1] : model;
        match = (/^"([^"]+)"$/gi).exec(model);
        this.model = (match ? match[1] : model).replace(/\//g, "%2F");
    }
}

ParsedStatement.prototype.metricName = function metricName() {
    return this.type + "/" + (this.model ? this.model : "NULL") + "/" + this.operation;
};

ParsedStatement.prototype.recordMetrics = function recordMetrics(segment, scope) {
    var template = '%s/%s/%s'; // scope id/cateogry id/metric
    var scopeId = this.type;

    var duration = segment.getDurationInMillis();
    var exclusive = segment.getExclusiveDurationInMillis();
    var action = segment.trace.action;

    var host = segment.host || UNKNOWN;
    var port = segment.port === 0 ? 0 : (segment.port || UNKNOWN);
    var database = segment.database || UNKNOWN;
    var tableName = this.model || UNKNOWN;
    //host:port%2Fdatabase
    var uri = util.format('%s:%s%s%s', host, port, '%2F', database);
    //host:port%2Fdatabase%2FtabaleName
    var tablePath = util.format('%s%s%s', uri, '%2F', tableName);
    var segmentName = util.format('%s/%s/%s', this.type, tablePath, this.operation);
    segment.setName(segmentName);
    var databaseCategoryId1 = tablePath;
    /*if (this.model) {
        action.measure(util.format(template, scopeId, databaseCategoryId1, this.operation), null, duration, exclusive);
    }*/
    if (scope) {
        action.measure(util.format(template, scopeId, databaseCategoryId1, this.operation), scope, duration, exclusive);
    }
    action.measure(util.format(template, scopeId, databaseCategoryId1, this.operation), null, duration, exclusive);
    var databaseCategoryId2 = uri;
    action.measure(util.format(template, scopeId, databaseCategoryId2, 'All'), null, duration, exclusive);

    action.measure(util.format(template, scopeId, 'NULL', this.operation), null, duration, exclusive);
    action.measure(util.format(template, scopeId, 'NULL', (action.isWeb() ? 'AllWeb' : 'AllOther')), null, duration, exclusive);
    action.measure(util.format(template, scopeId, 'NULL', 'All'), null, duration, exclusive);
};

module.exports = ParsedStatement;