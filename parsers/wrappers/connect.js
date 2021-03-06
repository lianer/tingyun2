'use strict';

var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger').child('parsers.wrappers.connect');

var key_words = {
    class: 1,
    const: 1,
    enum: 1,
    export: 1,
    extends: 1,
    implements: 1,
    import: 1,
    interface: 1,
    let: 1,
    package: 1,
    private: 1,
    protected: 1,
    public: 1,
    static: 1,
    super: 1,
    yield: 1
};

module.exports = function initialize(agent, connect) {
    var tracer = agent.tracer;

    var interceptor = {
        route: '',
        handle: function sentinel(error, req, res, next) {
            if (error) {
                var action = agent.tracer.getAction();
                if (action) {
                    action.setError(error);
                } else {
                    logger.error('catch connect error, but no action context!', error);
                }
            }
            return next(error);
        }
    };

    /**
     * Problem:
     *
     * 1. Connect determines whether middleware functions are error handlers by
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
    function wrapHandle(handler) {
        var template = function() {
            var a = tracer.slice(arguments);
            if (typeof a[a.length - 1] === 'function') {
                a[a.length - 1] = tracer.callbackProxy(a[a.length - 1]);
            }
            handler.apply(this, a);
        };
        var fdef = handler.toString();
        var name = handler.name ? handler.name : '';
        if (name.length && key_words[name]) {
            name += '_';
            fdef = ' function ' + name + fdef.slice(fdef.indexOf('('), fdef.indexOf(')') + 1);
        } else fdef = fdef.slice(0, fdef.indexOf(')') + 1);
        // jshint evil:true
        var wrapped = eval('(function(){return ' + fdef + template.toString().substring(11) + '}());');
        wrapped['__TY_original'] = handler;
        // jshint evil:false
        return wrapped;
    }

    function wrapUse(use) {
        return function cls_wrapUse() {
            if (!this.stack) return use.apply(this, arguments);

            this.stack = this.stack.filter(function cb_filter(m) {
                return m !== interceptor;
            });

            /* We allow `use` to go through the arguments so it can reject bad things
             * for us so we don't have to also do argument type checking.
             */
            var app = use.apply(this, arguments);

            // wrap most recently added unwrapped handler
            var top = this.stack.pop();
            if (top) {
                if (top.handle &&
                    typeof top.handle === 'function' &&
                    !top.handle['__TY_original']) {
                    top.handle = wrapHandle(top.handle);
                }
                this.stack.push(top);
            }

            /* Give the error tracer a better chance of intercepting errors by
             * putting it before the first error handler (a middleware that takes 4
             * parameters, in Connect's world). Error handlers tend to be placed
             * towards the end of the middleware chain and sometimes don't pass
             * errors along. Don't just put the interceptor at the beginning because
             * we want to allow as many middleware functions to execute as possible
             * before the interceptor is run, to increase error coverage.
             *
             * NOTE: This is heuristic, and works because interceptor propagates
             *       errors instead of terminating the middleware chain.
             *       Ignores routes.
             */
            var spliced = false;
            for (var i = 0; i < this.stack.length; i++) {
                var middleware = this.stack[i];
                // Check to see if it is an error handler middleware
                if (middleware &&
                    middleware.handle &&
                    middleware.handle.length === 4) {
                    this.stack.splice(i, 0, interceptor);
                    spliced = true;
                    break;
                }
            }
            if (!spliced) this.stack.push(interceptor);

            // don't break chaining
            return app;
        };
    }

    /**
     * Connect 1 and 2 are very different animals, but like Express, it mostly
     * comes down to factoring.
     */
    var version = connect && connect.version && connect.version[0];
    switch (version) {
        case '1':
            shimmer.wrapMethod(connect && connect.HTTPServer && connect.HTTPServer.prototype,
                'connect.HTTPServer.prototype',
                'use',
                wrapUse);
            break;

        case '2':
            shimmer.wrapMethod(connect && connect.proto,
                'connect.proto',
                'use',
                wrapUse);
            break;

        default:
            logger.verbose("Unrecognized version %s of Connect detected; not instrumenting.",
                version);
    }
};