'use strict';

var shimmer = require('../../util/shimmer');
var util = require('../../util/util');

module.exports = function initialize(agent, Promise) {

  var tracer = agent.tracer;

  //bluebird 2
  shimmer.wrapMethod(Promise.prototype, 'Promise.prototype', '_resolveFromResolver', wrapResolver);

  //bluebird 3.0+
  shimmer.wrapMethod(Promise.prototype, 'Promise.prototype', '_resolveFromExecutor', wrapResolver);

  function wrapResolver(resolver) {
    return tracer.segmentProxy(function() {
      return resolver.apply(this, arguments);
    });
  }

  shimmer.wrapMethod(Promise.prototype, 'Promise.prototype', '_then', wrapThen);

  function wrapThen(_then) {
    return tracer.segmentProxy(function() {
      var args = [];
      for (var i = 0, length = arguments.length; i < length; i++) {
        if (i < 3) {
          args[i] = wrapFunction(arguments[i]);
        } else {
          args[i] = arguments[i];
        }
      }

      return _then.apply(this, args);

      function wrapFunction(func) {
        return util.isFunction(func) ? tracer.callbackProxy(func) : func;
      }
    });
  }
};