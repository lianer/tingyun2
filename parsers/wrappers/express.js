'use strict';

var shimmer = require('../../util/shimmer.js');
var urltils = require('../../util/urltils.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.express');
var record = require('../../metrics/recorders/generic.js');

var ORIGINAL = '__TY_original';
var RESERVED = [ // http://es5.github.io/#x7.6.1.2
    // always (how would these even get here?)
    'class', 'enum', 'extends', 'super', 'const', 'export', 'import',
    // strict
    'implements', 'let', 'private', 'public', 'yield', 'interface',
    'package', 'protected', 'static'
];

function nameFromRoute(segment, route, params) {
    if (!segment) return logger.error("No TingYun context to set Express route name on.");
    if (!route) return logger.verbose("No Express route to use for naming.");

    // Express 4.3.0 changed where params live. On newer vesrions of express
    // params should be populated, on older it shouldn't be.
    params = params || route.params;

    var action = segment.trace.action,
        path = route.path || route.regexp;

    if (!path) return logger.verbose({
        route: route
    }, "No path found on Express route.");

    // when route is a regexp, route.path will be a regexp
    if (path instanceof RegExp) path = path.source;

    urltils.copyParameters(action.agent.config, params, segment.parameters);
    var action_id = action.verb + " " + path;
    action.setPartialName('Express/' + action_id.replace(/\//g, "%2F"));
}

module.exports = function initialize(agent, express) {
    var tracer = agent.tracer;

    var interceptor;
    // This is the error handler we inject for express4. Yanked from connect support.
    function sentinel(error, req, res, next) {
        if (error) {
            var action = agent.tracer.getAction();
            if (action) {
                action.setError(error);
            } else {
                logger.error('catch express error, but no action context!', error);
            }
        }
        return next(error);
    }

    function app_init(app) {
        return function on_init() {
            agent.environment.setDispatcher('express');
            agent.environment.setFramework('express');

            return app.apply(this, arguments);
        };
    }

    function wrapRender(version, render) {
        return function wp_Render(view, options, cb, parent, sub) {
            if (!agent.config.enabled) return render.apply(this, arguments);
            if (!tracer.getAction()) return render.apply(this, arguments);
            var classname = (version < 3) ? 'http.ServerResponse' : 'express.response';
            //            var name = "Express/" + view.replace(/\//g, "%2F") + '/' + classname + '.render';
            var name = "Express/" + classname + '/render';
            var segment_info = {
                metric_name: name,
                call_url: "",
                call_count: 1,
                class_name: classname,
                method_name: "render",
                params: {}
            }
            var segment = tracer.addSegment(segment_info, record);
            if (typeof options === 'function') {
                cb = options;
                options = null;
            }
            var self = this;
            var wrapped = tracer.callbackProxy(function render_cb(err, rendered) {
                segment.end();
                if (typeof cb === 'function') return cb.apply(this, arguments);
                if (err) {
                    logger.debug(err, "Express%d %s Render failed @action %s:", version, name, segment.trace.action.id);
                    return self.req.next(err);
                }
                var returned = self.send(rendered);
                logger.debug("Express%d %s Rendered @action %s.", version, name, segment.trace.action.id);
                return returned;
            });
            return render.call(this, view, options, wrapped, parent, sub);
        };
    }

    function wrapMatchRequest(version, matchRequest) {
        return function cls_wrapMatchRequest() {
            if (!agent.config.enabled) return matchRequest.apply(this, arguments);
            if (!tracer.getAction()) {
                logger.debug("Express %d router called outside action.", version);
                return matchRequest.apply(this, arguments);
            }
            var route = matchRequest.apply(this, arguments);
            nameFromRoute(tracer.getSegment(), route);
            return route;
        };
    }

    function wrapProcessParams(version, process_params) {
        return function cls_wrapProcessParams() {
            if (!agent.config.enabled) return process_params.apply(this, arguments);
            if (tracer.getAction() && arguments.length && arguments[0].route) {
                nameFromRoute(tracer.getSegment(), arguments[0].route, arguments[0].params);
            }
            return process_params.apply(this, arguments);
        };
    }

    /**
     * Problem:
     *
     * 1. Express determines whether middleware functions are error handlers by
     *    testing their arity. Not cool.
     * 2. Downstream Express users rely upon being able to iterate over their
     *    middleware stack to find specific middleware functions. Sorta less
     *    uncool, but still a pain.
     *
     * Solution:
     *
     * Use eval. This once. For this one specific purpose. Not anywhere else for
     * any reason.
     */
    function wrapHandle(__TY_handle) {
        var template = function() {
            if (!agent.config.enabled) return __TY_handle.apply(this, arguments);
            var args = tracer.slice(arguments);
            if (typeof args[args.length - 1] === 'function') {
                args[args.length - 1] = tracer.callbackProxy(args[args.length - 1]);
            }
            __TY_handle.apply(this, args);
        };
        var origin_method = __TY_handle.toString();

        try {

            // I am a bad person and this makes me feel bad.
            // We use eval because we need to insert the function with a specific name to allow for lookups.
            // jshint evil:true
            var wrapped = eval('(function(){return ' + origin_method.slice(0, origin_method.indexOf(')') + 1) + template.toString().substring(11) + '}());');
            // jshint evil:false
            wrapped[ORIGINAL] = __TY_handle;
        } catch (e) {
            return __TY_handle;
        }
        return wrapped;
    }

    function wrapMiddlewareStack(name, method) {
        return function cls_wrapMiddlewareStack() {
            //            if ( ! agent.config.enabled ) return method.apply(this, arguments);
            if (this.stack && this.stack.length) {
                this.stack = this.stack.filter(function cb_filter(m) {
                    return m !== interceptor;
                });
            }
            if (!interceptor) {
                // call use to create a Layer object, then pop it off and store it.
                method.call(this, '/', sentinel);
                interceptor = this.stack.pop();
            }

            var result = method.apply(this, arguments);

            if (name === 'use') {
                // wrap most recently added unwrapped handler
                var top = this.stack[this.stack.length - 1];
                if (top && typeof top.handle === 'function' && !top.handle[ORIGINAL]) {
                    top.handle = wrapHandle(top.handle);
                }
            }

            var spliced = false;
            for (var i = 0; i < this.stack.length; i++) {
                var middleware = this.stack[i];
                // Check to see if it is an error handler middleware
                if (middleware && middleware.handle && middleware.handle.length === 4) {
                    this.stack.splice(i, 0, interceptor);
                    spliced = true;
                    break;
                }
            }
            if (!spliced) this.stack.push(interceptor);
            return result;
        };
    }
    var version = express && express.version && express.version[0];
    if (!version && express && express.application &&
        express.application.init && express.response &&
        express.response.render && express.Router &&
        express.Router.prototype.matchRequest) {
        version = '3';
    } else if (!version && express && express.application &&
        express.application.init && express.response &&
        express.response.render && express.Router &&
        express.Router.process_params) {
        version = '4';
    }
    switch (version) {
        case '2':
            shimmer.wrapMethodOnce(express.createServer().routes.constructor.prototype, 'Router.prototype', '_match', wrapMatchRequest.bind(null, 2));
            shimmer.wrapMethodOnce(express, 'express', 'createServer', app_init);
            shimmer.wrapMethodOnce(require('http').ServerResponse.prototype, 'http.ServerResponse.prototype', 'render', wrapRender.bind(null, 2));
            break;
        case '3':
            shimmer.wrapMethodOnce(express.application, 'express.application', 'init', app_init);
            shimmer.wrapMethodOnce(express.response, 'express.response', 'render', wrapRender.bind(null, 3));
            shimmer.wrapMethodOnce(express.Router.prototype, 'express.Router.prototype', 'matchRequest', wrapMatchRequest.bind(null, 3));
            break;
        case '4':
            shimmer.wrapMethodOnce(express.application, 'express.application', 'init', app_init);
            shimmer.wrapMethodOnce(express.response, 'express.response', 'render', wrapRender.bind(null, 4));
            shimmer.wrapMethodOnce(express.Router, 'express.Router', 'process_params', wrapProcessParams.bind(null, 4));
            shimmer.wrapMethodOnce(express.Router, 'express.Router', 'use', wrapMiddlewareStack.bind(null, 'use'));
            shimmer.wrapMethodOnce(express.Router, 'express.Router', 'route', wrapMiddlewareStack.bind(null, 'route'));
            break;
        default:
            logger.warning("Unrecognized version %s of Express detected; not instrumenting", version);
            break;
    }
};