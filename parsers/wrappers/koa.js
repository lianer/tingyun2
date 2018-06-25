var shimmer = require('../../util/shimmer.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.koa');
var record = require('../../metrics/recorders/generic.js');
var urltils = require('../../util/urltils.js');

function convertAsyncToGenerator(fn) {
    return function() {
        var gen = fn.apply(this, arguments);
        return new Promise(function(resolve, reject) {
            function step(key, arg) {
                try {
                    var info = gen[key](arg);
                    var value = info.value;
                } catch (error) {
                    reject(error);
                    return;
                }
                if (info.done) {
                    resolve(value);
                } else {
                    return Promise.resolve(value).then(function(value) {
                        return step("next", value);
                    }, function(err) {
                        return step("throw", err);
                    });
                }
            }
            return step("next");
        });
    }
}

function checkKoa(Application) {
    try {
        Application();
    } catch (e) {
        return true;
    }
    return false;
}

function wrapRender(agent, context, render) {
    return function*(view, locals) {
        var action = agent.tracer.getAction();
        if (agent.config.enabled && action) {
            var segment = createRenderSegment(agent.tracer, record);
            yield render.apply(context, arguments);
            segment.end();
        } else {
            yield render.apply(context, arguments);
        }
    }
}

function wrapNextRender(agent, context, render) {
    return function() {
        var action = agent.tracer.getAction();
        if (agent.config.enabled && action) {
            var segment = createRenderSegment(agent.tracer, record);
            return render.apply(this, arguments).then(function() {
                segment.end();
            });
        }
        return render.apply(this, arguments);
    }
}

function createRenderSegment(tracer, record) {
    var className = 'View';
    var name = "Koa/" + className + '/render';
    var segmentInfo = {
        metric_name: name,
        call_url: "",
        call_count: 1,
        class_name: className,
        method_name: "render",
        params: {}
    }
    return tracer.addSegment(segmentInfo, record);
}

function convert(gen) {
    var ref = convertAsyncToGenerator(gen);
    return function(_x, _x2) {
        return ref.apply(this, arguments);
    }
}

function findMatchedRouter(layers) {
    var length = layers && layers.length;
    if (!length) {
        logger.debug('koa-router matched not found!');
        return null;
    }
    for (var i = length - 1; i >= 0; i--) {
        if (layers[i].opts && layers[i].opts.end) {
            return layers[i].path;
        }
    }
    return null;
}

function addRouteInterceptor(middleware, agent, isKoaNext) {
    var interceptor = isKoaNext ? convert(function*(ctx, next) {
        yield next();
        var matchedRoute = findMatchedRouter(ctx.matched);
        if (matchedRoute) {
            setRouterName.bind(ctx)(agent, matchedRoute);
        }
    }) : function*(next) {
        yield next;
        if (this._matchedRoute) {
            if (this.status && this.status !== 404) {
                setRouterName.bind(this)(agent, this._matchedRoute);
            } else {
                logger.debug('matched path not found, response with %s!', this.status);
            }
        } else {
            logger.debug('koa-router._matchedRoute not found, please upgrade koa-router(v5.4.0+ supported)!');
        }
    };
    middleware.unshift(interceptor);
}

function setRouterName(agent, matchedRoute) {
    var name = this.method + " " + matchedRoute;
    var action = agent.getAction();
    if (action) {
        var segment = agent.tracer.getSegment();
        segment.parameters = segment.parameters || {};
        var params = this.query;
        urltils.copyParameters(agent.config, params, segment.parameters);
        urltils.copyParameters(agent.config, this.params || {}, segment.parameters);
        if (!action.partialName) {
            action.setPartialName('Koa/' + name.replace(/\//g, "%2F"));
        }
    }
}

function defineRender(wrapper, agent) {
    var _render = this.render;
    var setter = function(render) {
        if (typeof render === 'function') {
            logger.debug('wrap render function of koa-view');
            _render = wrapper(agent, this, render);
        } else {
            _render = render;
        }
    };
    Object.defineProperty(this, 'render', {
        get: function() {
            return _render;
        },
        set: setter.bind(this),
        configurable: true,
        enumerable: true
    });
}

function addViewInterceptor(middleware, agent, isKoaNext) {
    var interceptor = isKoaNext ? convert(function*(ctx, next) {
        defineRender.bind(ctx)(wrapNextRender, agent);
        yield next();
    }) : function*(next) {
        defineRender.bind(this)(wrapRender, agent);
        yield next;
    };
    middleware.unshift(interceptor);
}

function addErrorEvent(agent, isKoaNext) {
    this.on('error', function(error, context) {
        logger.error("Catch koa error:", error);
        var action = agent.getAction();
        if (!action) {
            return logger.error("koa error, but without action context", error);
        }
        var status = error.status || 500;
        action.statusCode = status;
        action.setError(error);
        if (context) {
            var matchedRoute = context._matchedRoute;
            if (matchedRoute) {
                setRouterName.bind(context)(agent, matchedRoute);
            } else if (isKoaNext && context.matched) {
                matchedRoute = findMatchedRouter(context.matched);
            }
            if (matchedRoute) {
                setRouterName.bind(context)(agent, matchedRoute);
            }
        }
    });
}

module.exports = function initialize(agent, Application) {
    if (!Application || !Application.prototype) {
        return logger.verbose("Application's prototype does not exists.");
    }

    var isKoaNext = checkKoa(Application);

    shimmer.wrapMethodOnce(Application.prototype, 'Application.prototype', 'callback', function(callback) {
        return function() {
            logger.debug("Setup koa environment.");
            var name = isKoaNext ? 'Koa2' : 'Koa';
            agent.environment.setDispatcher(name);
            agent.environment.setFramework(name);

            addRouteInterceptor(this.middleware, agent, isKoaNext);
            addViewInterceptor(this.middleware, agent, isKoaNext);

            addErrorEvent.bind(this)(agent, isKoaNext);

            var listener = callback.apply(this, arguments);
            return function _listener(req, res) {
                return listener.apply(this, arguments);
            }
        }
    });
};