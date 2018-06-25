'use strict';

var QuantileP2 = require('../common/quantile');
var logger = require('../util/logger').child('metrics.quantile-holder');

function QuantileHolder(config) {
    this.config = config;
    this.data = {};
}

QuantileHolder.prototype.add = function(name, value) {
    var quantile = this.config.quantile;
    if (!quantile) {
        logger.debug('nbs.quantile is not set.');
        return;
    }
    if (!name) {
        logger.debug("web action's name is not set");
        return;
    }
    if (!this.data[name]) {
        this.data[name] = new QuantileP2(quantile);
    }
    this.data[name].add(value);
};

QuantileHolder.prototype.reset = function() {
    this.data = {};
    return this;
};

QuantileHolder.prototype.getResult = function(name) {
    var quantile;
    if (name && (quantile = this.data[name])) {
        return quantile.markers();
    }
    return null;
};

module.exports = QuantileHolder;