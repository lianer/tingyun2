var logger = require('../util/logger.js').child('API');
var recordWeb = require('../metrics/recorders/http');

function API(agent) {
    if (!agent) {
        throw new Error('Agent is null in API');
    }
    this.agent = agent;
}

API.prototype = {
    getBrowserMonitorScript: function() {
        var action = this.agent.getAction(),
            scriptConfig,
            traceInfo,
            agentStatics,
            remoteScript,
            pos,
            script = '';
        if (!action) {
            logger.error('Action is null in API');
            return script;
        }
        if (!this.agent.config) {
            logger.error('Config is null in API');
            return script;
        }
        scriptConfig = this.agent.config.rum;
        if (scriptConfig.enabled && scriptConfig.ratio > Math.random(0, 1)) {
            remoteScript = scriptConfig.script;
            if (!remoteScript) {
                logger.error("Script did not return from server side.");
                return script;
            }
            traceInfo = action.getTraceDurations();
            if (!traceInfo) {
                logger.error("Action's traceInfo is null");
                return script;
            }
            try {
                traceInfo = JSON.parse(traceInfo);
                if (!traceInfo) {
                    logger.error("parse action's traceInfo error");
                    return script;
                }
            } catch (e) {
                logger.error("parse action's traceInfo error");
                return script;
            }
            agentStatics = {
                id: traceInfo.id,
                n: traceInfo.action,
                a: parseInt(traceInfo.time.duration),
                q: parseInt(traceInfo.time.qu),
                tid: traceInfo.trId
            };
            var pos = remoteScript.lastIndexOf('}');
            agentStatics = JSON.stringify(agentStatics);
            script = remoteScript.substr(0, pos) + ';ty_rum.agent = ' + agentStatics + ';' + remoteScript.substr(pos);
            script = '<script type="text/javascript" data-tingyun="tingyun">' + script + '</script>';
        } else {
            logger.debug('Server side configuration(rum.enabled) is disabled, or randomly choose not to monitor.');
        }
        return script;
    },
    noticeError: function(message, error) {
        if (!arguments.length) {
            logger.warning('illegal argument, missing error info.');
            return this;
        }
        if (message instanceof Error) {
            error = message;
            message = null;
        }
        if (!error || !(error instanceof Error)) {
            logger.warning('illegal error argument');
            return this;
        }
        var action = this.agent.getAction();
        if (action) {
            action.forceError = true;
            action.error = error;
        } else {
            logger.error('error set by user, but no action context!', error);
        }
        return this;
    },
    noticeException: function(message, exception) {
        if (!arguments.length) {
            logger.warning('illegal argument, missing exception info.');
            return this;
        }
        if (message instanceof Error) {
            exception = message;
            message = null;
        }
        if (!exception || !(exception instanceof Error)) {
            logger.warning('illegal exception argument');
            return this;
        }
        var action = this.agent.getAction();
        if (action) {
            action.addExceptions(exception);
        } else {
            logger.error('exception set by user, but no action context!', exception);
        }
        return this;
    },
    setWebActionName: function(name) {
        if (typeof name !== 'string') {
            logger.warning('illegal argument, action name must be a string type.');
            return this;
        }
        if (!name) {
            logger.warning('Action name can not be empty.');
            return this;
        }
        var action = this.agent.getAction();
        if (action) {
            action.setPartialName(name);
            var newName = 'WebAction/' + name;
            action.applyCustomeActionName = true;
            action.name = newName;
        }
        return this;
    },
    createWebAction: function(name, crossAppHeader, handler) {
        var self = this;
        var tracer = this.agent.tracer;
        if (typeof name === 'function') {
            handler = name;
            name = null;
            crossAppHeader = null;
        } else if (typeof crossAppHeader === 'function') {
            handler = crossAppHeader;
            crossAppHeader = null;
        }
        if (typeof handler !== 'function') {
            throw new Error('handler must be a function!');
        }
        var action = tracer.getAction();
        if (action) {
            wrapped = function actionInvocation() {
                action.reset();
                self.setWebActionName(name);
                return handler.apply(this, arguments);
            }
        } else {
            wrapped = tracer.actionProxy(function() {
                var action = tracer.getAction();
                tracer.setSegment(action.getTrace().init(action).root);
                self.setWebActionName(name);
                var segmentInfo = {
                    metric_name: "NodeJS/NULL/Root",
                    call_url: "",
                    call_count: 1,
                    class_name: "listener",
                    method_name: "request",
                    params: {}
                };
                if (action) {
                    action.customRootSegment = tracer.addSegment(segmentInfo, recordWeb);
                }
                return handler.apply(this, arguments);
            });
        }
        return wrapped;
    },
    endWebAction: function() {
        var action = this.agent.getAction();
        if (action) {
            if (action.customRootSegment) {
                action.customRootSegment.partialName = action.partialName;
                action.customRootSegment.end();
            }
            action.end();
        }
        return this;
    }
};

module.exports = API;