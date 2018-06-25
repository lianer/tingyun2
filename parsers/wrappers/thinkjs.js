var shimmer = require('../../util/shimmer.js');
var logger = require('../../util/logger.js').child('parsers.wrappers.thinkjs');
var record = require('../../metrics/recorders/generic.js');
var urltils = require('../../util/urltils.js');

var THINKJS = 'thinkjs';

module.exports = function initialize(agent, thinkjs) {
    if (!thinkjs || !thinkjs.prototype) {
        return logger.verbose("thinkjs or its prototype does not exists.");
    }
    shimmer.wrapMethodOnce(thinkjs.prototype, 'thinkjs.prototype', 'run', function(run) {
        return function() {
            var result = run.apply(this, arguments);
            agent.environment.setDispatcher(THINKJS);
            agent.environment.setFramework(THINKJS);
            hookThink(thinkjs, agent);
            return result;
        }
    });
};

function hookThink(thinkjs, agent) {
    var thinkData = global.thinkData;
    if (!thinkData) {
        return logger.verbose("global.thinkData does not exists.");
    }
    var exportModules = global.thinkData.export;
    if (!exportModules) {
        return logger.verbose("thinkjs does not have any export module.");
    }
    var app = exportModules['app'];
    if (!app || !app.prototype) {
        return logger.verbose("thinkjs.app or its prototype does not exists.");
    }
    if (global.think) {
        shimmer.wrapMethodOnce(global.think, 'global.think', 'statusAction', function(statusAction) {
            return function(status, http, log) {
                var error = http && http.error;
                if (error && !http._error && !global.think.isPrevent(error)) {
                    logger.debug('Agent catches error within thinkjs', error);
                    var action = agent.getAction();
                    if (action) {
                        var status = error.status || 500;
                        action.statusCode = status;
                        action.setError(error);
                        setActionName(action, http);
                    } else {
                        logger.error('thinkjs error, but without action context!', error);
                    }
                }
                return statusAction.apply(this, arguments);
            }
        });
    }
    shimmer.wrapMethodOnce(app.prototype, 'thinkjs.app.prototype', 'execController', function(execController) {
        return function() {
            var http;
            if ((http = this.http) && !http.error) {
                setActionName(agent.getAction(), http);
            }
            return execController.apply(this, arguments);
        }
    });
}

function setActionName(action, http) {
    if (!action || !http) {
        return;
    }
    if (!action.partialName && !http._isResource) {
        action.setPartialName(getRouterName(http).replace(/\//g, "%2F"));
    }
}

function getRouterName(http) {
    return http ? (THINKJS + '/' + http.method + ' ' + [http.module || '', http.controller || '', http.action || ''].join('/')) : '';
}