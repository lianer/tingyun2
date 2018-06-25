'use strict';

var logger = require('../util/logger').child('metrics.mapper');
var Cache = require('../common/cache');

function NameMap(raw) {
    this.cache = new Cache(1000);
  this.load(raw);
}

function serializeKey(obj) {
    var key = '';
    if (typeof obj === 'object') {
        var objKeys = Object.keys(obj);
        for (var i = objKeys.length - 1; i >= 0; i--) {
            key += (obj[objKeys[i]] + '|');
        }
    } else {
        logger.debug('non-object', obj);
    }
    return key;
}

NameMap.prototype.load = function load(raw) {
    if (!raw) {
        return;
    }
    var metricTypes = Object.keys(raw);
    for (var i = metricTypes.length - 1, type, parsedData; i >= 0; i--) {
        type = metricTypes[i];
        parsedData = raw[type];
        for (var j = parsedData.length - 1; j >= 0; j--) {
            store.call(this, parsedData[j]);
    }
  }

    function store(data) {
        var key = serializeKey(data[0]);
        if (key) {
            var serializedValue = data[1];
            this.cache.put(key, serializedValue);
    }
  }
};

NameMap.prototype.map = function load(key) {
    if (typeof key === 'object') {
        var value = this.cache.get(serializeKey(key));
        return value ? value : key;
  }
    return key;
};

NameMap.prototype.clear = function () {
    this.cache.clear();
}

module.exports = NameMap;
