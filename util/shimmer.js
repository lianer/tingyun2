'use strict';

var path = require('path');
var logger = require('./logger').child('util.shimmer');

var WRAPPERS = [
    'connect',
    'express',
    'generic-pool',
    'hapi',
    'memcached',
    'mongodb',
    'mysql',
    'mysql2',
    'mysql2/promise',
    'node-cassandra-cql',
    'pg',
    'sqlite3',
    'redis',
    'restify',
    'thrift',
    'oracledb',
    'oracle',
    'ioredis',
    'koa',
    'bluebird',
    'callback_api', // amqplib/callback_api
    'amqplib',
    'stompit',
    'kafka-node',
    'thinkjs'
];

var instrumented = [];

function instrument(agent, shortName, fileName, nodule, param) {
    try {
        require(fileName)(agent, nodule, param);
    } catch (error) {
        logger.verbose(error, "wrap module %s failed.", path.basename(shortName, ".js"));
    }
}

function _postLoad(agent, nodule, name) {
    var base = path.basename(name);
    var wrapper_module = (name === 'pg.js') ? 'pg' : base;
    if (WRAPPERS.indexOf(wrapper_module) !== -1) {
        logger.debug('wrap %s.', base);
        var filename;
        if (name == 'amqplib/callback_api') {
            filename = path.join(__dirname, '../parsers/wrappers', name + '.js');
        } else if (name == 'amqplib') {
            filename = path.join(__dirname, '../parsers/wrappers', name, 'index.js');
        } else {
            filename = path.join(__dirname, '../parsers/wrappers', wrapper_module + '.js');
        }
        instrument(agent, base, filename, nodule);
    }
    return nodule;
}

var shimmer = module.exports = {
    debug: false,
    wrapMethodOnce: function wrapMethodOnce(nodule, noduleName, method, wrapper) {
        if (!noduleName) noduleName = '[unknown]';
        var method_name = noduleName + '.' + method;
        var original = nodule[method];
        if (!original) {
            return logger.debug("%s not defined, skip wrapping.", method_name);
        }
        if (original.__TY_unwrap) return;
        var wrapped = wrapper(original);
        wrapped.__TY_original = original;
        wrapped.__TY_unwrap = function __TY_unwrap() {
            nodule[method] = original;
            logger.debug("Removed instrumentation from %s.", method_name);
        };

        nodule[method] = wrapped;
        if (shimmer.debug) instrumented.push(wrapped);
    },
    wrapMethod: function wrapMethod(nodule, noduleName, methods, wrapper) {
        if (!methods) return;
        if (!noduleName) noduleName = '[unknown]';
        if (!Array.isArray(methods)) methods = [methods];

        methods.forEach(function cb_forEach(method) {
            var method_name = noduleName + '.' + method;

            if (!nodule) return;
            if (!wrapper) return logger.verbose("Can't wrap %s, no wrapper.", method_name);
            var original = nodule[method];

            if (!original) return logger.debug("%s not defined, skip wrapping.", method_name);
            if (original.__TY_unwrap) return logger.verbose("%s already wrapped.", method_name);

            var wrapped = wrapper(original, method);
            wrapped.__TY_original = original;
            wrapped.__TY_unwrap = function __TY_unwrap() {
                nodule[method] = original;
                logger.debug("Removed instrumentation from %s.", method_name);
            };

            nodule[method] = wrapped;
            if (shimmer.debug) instrumented.push(wrapped);
        });
    },

    wrapDeprecated: function wrapDeprecated(nodule, noduleName, property, options) {
        if (!property) {
            logger.warning(new Error(), "Must include a function name to wrap. Called from:");
            return;
        }
        if (!noduleName) noduleName = '[unknown]';
        if (!nodule) return;
        var original = nodule[property];
        if (!original) return;
        delete nodule[property];

        var descriptor = {
            configurable: true,
            enumerable: true
        };
        if (options.get) descriptor.get = options.get;
        if (options.set) descriptor.set = options.set;
        Object.defineProperty(nodule, property, descriptor);
        return original;
    },

    unwrapMethod: function unwrapMethod(nodule, noduleName, method) {
        if (!noduleName) noduleName = '[unknown]';
        if (!method) return 'no method name';
        if (!nodule) return 'not object';
        var wrapped = nodule[method];
        var pos = instrumented.indexOf(wrapped);
        if (pos !== -1) instrumented.splice(pos, 1);
        if (!wrapped) return 'method not exist';
        if (!wrapped.__TY_unwrap) return 'not wrapped';
        wrapped.__TY_unwrap();
        return 'success';
    },

    unwrapAll: function unwrapAll() {
        instrumented.forEach(function cb_forEach(wrapper) {
            wrapper.__TY_unwrap();
        });
        instrumented = [];
    },

    /**
     * Patch the module.load function so that we see modules loading and
     * have an opportunity to patch them with instrumentation.
     */
    patchModule: function patchModule(agent) {
        logger.debug("Wrapping module loader.");
        var Module = require('module');

        shimmer.wrapMethod(Module, 'Module', '_load', function cb_wrapMethod(load) {
            return function cls_wrapMethod(file) {
                if (file == 'mysql2/promise') {
                    logger.debug('require mysql2/promise, load mysql2 first');
                    try {
                        require('mysql2');
                    } catch (e) {
                        logger.debug('maybe mysql2 is not installed.');
                    }
                }
                return _postLoad(agent, load.apply(this, arguments), file);
            };
        });
    },

    unpatchModule: function unpatchModule() {
        logger.debug("Unwrapping to previous module loader.");
        var Module = require('module');

        shimmer.unwrapMethod(Module, 'Module', '_load');
    },

    bootstrapInstrumentation: function bootstrapInstrumentation(agent) {
        var filepath = path.join(__dirname, '../parsers/wrappers/core/http.js');
        instrument(agent, "http.js", filepath, require("http"), 'http');
        instrument(agent, "http.js", filepath, require("https"), 'https');
    },

    /**
     * NOT FOR USE IN PRODUCTION CODE
     *
     * If an instrumented module has a dependency on another instrumented module,
     * and multiple tests are being run in a single test suite with their own
     * setup and teardown between tests, it's possible transitive dependencies
     * will be unwrapped in the module cache in-place (which needs to happen to
     * prevent stale closures from channeling instrumentation data to incorrect
     * agents, but which means the transitive dependencies won't get rewrapped
     * the next time the parent module is required).
     *
     * Since this only applies in test code, it's not worth the drastic
     * monkeypatching to Module necessary to walk the list of child modules and
     * rewrap them.
     *
     * Use this to re-apply any applicable instrumentation.
     */
    reinstrument: function reinstrument(agent, path) {
        return _postLoad(agent, require(path), path);
    }
};