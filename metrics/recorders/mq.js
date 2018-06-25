'use strict';

var fmt = require('util').format;
var logger = require('../../util/logger').child('recorders.mq');

var METRIC_NAME = 'Message %s/%s/%s';
var METRIC_EX_NAME = 'Message %s/%s/%s%s%s';
var UNKNOWN = 'Unknown';

module.exports = function init(libName) {
    return function record(segment, scope) {
        var action = segment.trace.action;
        if (!action) {
            return logger.debug('action is null when ending %s segment.', libName || 'mq');
        }
        var mq = segment.mq;
        if (!mq) {
            return logger.debug('no mq info!');
        }
        var duration = segment.getDurationInMillis();
        var exclusive = action.consumer ? 0 : segment.getExclusiveDurationInMillis();

        var size = mq.size;
        var host = segment.host || UNKNOWN;
        var port = segment.port === 0 ? segment.port : (segment.port || UNKNOWN);
        var address = fmt('%s:%s', host, port);
        var type = mq.type || UNKNOWN;
        var opType = mq.opType;
        if (!opType) {
            opType = segment.segment_data.method_name == 'publish' ? 'Produce' : 'Consume';
        }

        var categoryId = fmt('%s:%s%s%s%s%s', host, port, '%2F', type, '%2F', segment.name);
        var fullName = fmt(METRIC_NAME, libName, categoryId, opType);
        // reset segment metric_name, using this name in action trace data
        segment.segment_data.metric_name = fullName;
        //measure time
        if (scope) {
            action.measure(fullName, scope, duration, exclusive);
        }
        action.measure(fullName, null, duration, exclusive);
        action.measure(fmt(METRIC_NAME, libName, address, opType), null, duration, exclusive);
        action.measure(fmt(METRIC_NAME, libName, 'NULL', action.isWeb() ? 'AllWeb' : 'AllBackground'), null, duration, exclusive);
        action.measure(fmt(METRIC_NAME, libName, 'NULL', 'All'), null, duration, exclusive);
        //measure byte
        action.metrics.measureByBytes(fmt(METRIC_EX_NAME, libName, categoryId, opType, '%2F', 'Byte'), size);
        if (mq.wait) {
            action.measure(fmt(METRIC_EX_NAME, libName, categoryId, opType, '%2F', 'Wait'), null, mq.wait, mq.wait);
        }
    }
};