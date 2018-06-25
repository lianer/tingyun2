var shimmer = require('../../util/shimmer.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.director');
var record = require('../../metrics/recorders/generic.js');
var util = require('../../util/util.js');

module.exports = function initialize(agent, director) {
    if (!director || !director.Router) {
        return logger.verbose("Director router does not exists.");
    }

    var httpMethods = director.http.methods;

    shimmer.wrapMethodOnce(director.Router.prototype, 'director.Router.prototype', 'mount', function(mount) {
        return function(routes, path) {
            if (!routes || typeof routes !== 'object') {
                logger.debug('router.mount parameters mismatched!');
                return mount.apply(this, arguments);
            }
            if (!agent.enabled()) {
                logger.debug('agent disabled!');
                return mount.apply(this, arguments);
            }

            Object.keys(routes).forEach(function(method) {
                var routeHandler = httpMethods[method];
                if (util.isFunction(routeHandler)) {
                    routes[method] = wrapRouteHandler(agent, method, routeHandler, path);
                }
            });

            return mount.apply(this, arguments);
        }
    });
};

function wrapRouteHandler(agent, method, handler, path) {
    return agent.tracer.segmentProxy(function() {
        var action = agent.getAction();
        if (!action) {
            return handler.apply(this, arguments);
        }
        var handlerName = handler.name || 'anonymous';
        var segment = agent.tracer.addSegment({
            metric_name: 'director/' + handlerName,
            call_url: this.req && this.req.url || '',
            call_count: 1,
            class_name: "director.Router",
            method_name: handlerName,
            params: {}
        }, record);
        var result = handler.apply(this, arguments);
        segment.end();
        if (!action.partialName) {
            var partialName = 'director/' + method + ' ' + path && path.join('/') || '';
            action.setPartialName(partialName.replace(/\//g, "%2F"));
        }
        return result;
    });
}