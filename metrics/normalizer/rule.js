'use strict';

var logger = require('../../util/logger').child('metrics.normalizer.rule');

var replaceReplacer = function replaceReplacer(input) {
  return input.replace(/\\/g, '$');
};

function NormalizerRule(json) {
  if (!json) {
    logger.verbose("Received incompletely specified metric normalization rule from collector.");
    json = {};
  }

  this.eachSegment   = json.each_segment                || false;
  this.precedence    = json.eval_order                  || 0;
  this.isTerminal    = json.terminate_chain             || false;
  this.replacement   = replaceReplacer(json.replacement || '$0');
  this.replaceAll    = json.replace_all                 || false;
  this.ignore        = json.ignore                      || false;
  this.isStaticAsset = json.eval_order == 1000;

  var modifiers = '';
  if (this.replaceAll) modifiers += 'g';

  // don't allow this to fail
  if (json.match_expression instanceof RegExp) {
    this.pattern = json.match_expression;
  }
  else {
    try {
      this.pattern = new RegExp(json.match_expression || '^$', modifiers);
      logger.debug("Loaded normalization rule: %j", this);
    }
    catch (error) {
      logger.warning(error, "Problem compiling metric normalization rule pattern.");
      this.pattern = /^$/;
    }
  }
}

NormalizerRule.prototype.getSegments = function getSegments(input) {
  if (this.eachSegment) return input.split('/');
  else return [input];
};

NormalizerRule.prototype.matches = function matches(input) {
  var segments = this.getSegments(input);

  for (var i = 0; i < segments.length; i++) {
    if (segments[i].match(this.pattern)) return true;
  }

  return false;
};

NormalizerRule.prototype.apply = function apply(input) {
  return this.getSegments(input).map(function cb_map(segment) {
      if (segment === "") return segment;

      return segment.replace(this.pattern, this.replacement);
    }.bind(this))
    .join('/');
};

NormalizerRule.prototype.toJSON = function toJSON() {
  return {
    eachSegment : this.eachSegment,
    precedence  : this.precedence,
    isTerminal  : this.isTerminal,
    replacement : this.replacement,
    replaceAll  : this.replaceAll,
    ignore      : this.ignore,
    pattern     : this.pattern.source
  };
};

module.exports = NormalizerRule;
