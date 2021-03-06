'use strict';

var logger    = require('../util/logger').child('metrics.normalizer');
var deepEqual = require('../util/deep-equal');
var Rule      = require('./normalizer/rule');

function url(normalized, path, config) {
    if (normalized) return 'NormalizedUri' + normalized;
    return (config.enforce_backstop)?'NormalizedUri/*':'Uri' + path;
}

function plain(normalized, path) { return (normalized)?normalized: path; }

function Normalizer(config, type) {
    this.config = config;
    this.type = type;
    this.formatter = (type === 'URL')? url: plain;
    this.rules = [];
}

Normalizer.prototype.load = function load(json) {
    if (json) {
        logger.verbose("Received %s %s normalization rule(s)", json.length, this.type);

        for ( var i = 0 ; i < json.length; i++ ) {
            var rule = new Rule(json[i]);
            if (!this.rules.some(function cb_some(r) { return deepEqual(r, rule); })) {
                this.rules.push(rule);
            }
        }
        this.rules.sort(function cb_sort(a, b) { return a.precedence - b.precedence; });

        logger.verbose("Normalized to %s %s normalization rule(s).", this.rules.length, this.type);
    }
};

Normalizer.prototype.loadFromConfig = function loadFromConfig() {
    var rules = this.config.rules;

    if (rules && rules.name && rules.name.length > 0) {

        rules.name.forEach(function cb_forEach(rule) {

            if (!rule.pattern) return logger.error({rule : rule}, "Simple naming rules require a pattern.");

            if (!rule.name) return logger.error({rule : rule}, "Simple naming rules require a replacement name.");

            this.addSimple(rule.pattern, rule.name);

        }, this);
    }

    if (rules && rules.ignore && rules.ignore.length > 0) {

        rules.ignore.forEach(function cb_forEach(pattern) { this.addSimple(pattern); }, this);
    }
};

Normalizer.prototype.addSimple = function addSimple(pattern, name) {

    if (!pattern) return logger.error("Simple naming rules require a pattern.");

    var json = {
        match_expression : pattern,
        terminate_chain  : true
    };

    if (name) json.replacement = name;
    else json.ignore = true;
    this.rules.unshift(new Rule(json));
};

Normalizer.prototype.isIgnored = function isIgnored(path) {
    var length = this.rules.length;
    for (var i = 0; i < length; i++) {
        var rule = this.rules[i];
        if (rule.ignore && rule.matches(path)) {
            logger.debug("Ignoring %s because of rule: %j", path, rule);
            return true;
        }
    }

    return false;
};

Normalizer.prototype.isNormalized = function isNormalized(path) {
    var length = this.rules.length;
    for (var i = 0; i < length; i++) {
        var rule = this.rules[i];
        if (!rule.ignore && rule.matches(path)) {
            logger.debug("Normalizing %s because of rule: %j", path, rule);
            return true;
        }
    }

    return false;
};

Normalizer.prototype.normalize = function normalize(path, action) {
    var last   = path;
    var length = this.rules.length;
    var normalized;

    for (var i = 0; i < length; i++) {
        var rule = this.rules[i];
        if (rule.matches(last)) {
            if (action) {
                action.isStaticAsset = rule.isStaticAsset;
            }
            normalized = rule.apply(last);
            if (rule.isTerminal) break;
            last = normalized;
        }
    }
    return this.formatter(normalized, path, this.config);
};

module.exports = Normalizer;
