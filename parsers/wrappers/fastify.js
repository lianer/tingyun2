'use strict';

var fmt = require('util').format;
var shimmer = require('../../util/shimmer');
var logger = require('../../util/logger.js').child('parsers.wrappers.fastify');

module.exports = function initialize(agent, fastify) {
    logger.debug("Setup fastify environment.");

    var env = agent.environment;
    env.setDispatcher('fastify');
    env.setFramework('fastify');

    shimmer.wrapMethod(fastify, 'fastify', ['delete', 'get', 'head', 'patch', 'post', 'put', 'options'], function (original, method) {
        return function (url, opts, handler) {
            if (!handler && typeof opts === 'function') {
                handler = opts;
                opts = {};
            }
            var wrappedHandler;
            if (typeof handler === 'function') {
                wrappedHandler = function () {
                    var action = agent.getAction();
                    if (action) {
                        action.setPartialName(getName(method, url));
                    }
                    return handler.apply(this, arguments);
                };
            }
            return original.call(this, url, opts, wrappedHandler || handler);
        }
    });

    shimmer.wrapMethod(fastify, 'fastify', 'route', function (route) {
        return function (opts) {
            var handler = opts.handler;
            if (typeof handler === 'function') {
                opts.handler = function () {
                    var action = agent.getAction();
                    if (action) {
                        action.setPartialName(getName(opts.method, opts.url));
                    }
                    return handler.apply(this, arguments);;
                };
            }
            return route.apply(this, arguments);
        }
    });
};

function getName(method, url) {
    return fmt('fastify %s/%s', method.toUpperCase(), url.replace(/\//g, "%2F"));
}