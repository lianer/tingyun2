'use strict';

var Action = require('./action.js');
var logger = require('../util/logger').child('parsers.tracer');
var ORIGINAL = '__TY_original';
var action_space = require('../util/call_space')('__TY_tracer');

process.on('unhandledRejection', function(reason, p) {
    if (!action_space.cleanId) {
        action_space.clean();
    }
    var activeContext = action_space.active;
    if (activeContext) {
        action_space.leave(activeContext);
        activeContext.__proto__ = Object.prototype;
    }
});

function patchError(agent, action_space) {
    var callbacks = action_space && action_space.id;
    if (callbacks && callbacks.error) {
        callbacks.error = function cb_error(domain, error) {
            var context = action_space.fromException(error);
            var action = (domain && domain.action) || (context && context.action);
            if (action) {
                action.setError(error);
            } else {
                logger.error('tracer error', error);
            }
            if (domain) {
                action_space.leave(domain);
            }
        };
    }
}

function Tracer(agent) {
    this.agent = agent;
    patchError(agent, action_space);
}

Tracer.prototype.getAction = function getAction() {
    var action = action_space.get('action');
    if (action && action.isActive()) {
        return action;
    }
};

Tracer.prototype.setAction = function setAction(action) {
    action_space.set('action', action);
};

Tracer.prototype.getSegment = function getSegment() {
    return action_space.get('segment');
};

Tracer.prototype.setSegment = function setSegment(segment) {
    action_space.set('segment', segment);
};

Tracer.prototype.addSegment = function addSegment(seg_info, recorder) {
    var current = action_space.get('segment');
    var segment = current.add(seg_info, recorder);
    action_space.set('segment', segment);
    return segment;
};

Tracer.prototype.actionProxy = function actionProxy(handler) {
    if (!handler) {
        return;
    }
    var self = this;
    var count = 0;
    var localSample = this.agent.config['local.sample'];
    var wrapped = function wrapActionInvocation() {
        if (localSample && (count++ % localSample !== 0)) {
            if (count >= 1000) {
                count = 0;
            }
            return handler.apply(this, arguments);
        }
        var action = self.getAction() || new Action(self.agent);
        var proxied = this;
        var args = self.slice(arguments);
        var returned;
        action_space.bind(function cb_bind() {
            self.setAction(action);
            self.setSegment(action.getTrace().root);
            returned = action_space.bind(handler).apply(proxied, args);
        }, Object.create(null))();
        return returned;
    };
    wrapped[ORIGINAL] = handler;
    return wrapped;
};

Tracer.prototype.segmentProxy = function segmentProxy(handler) {
    if (!handler) {
        return;
    }
    var self = this;
    var wrapped = function wrapSegmentInvocation() {
        if (!self.getAction()) {
            return handler.apply(this, arguments);
        }
        return action_space.bind(handler, action_space.createContext()).apply(this, arguments);
    };
    wrapped[ORIGINAL] = handler;
    return wrapped;
};

Tracer.prototype.callbackProxy = function callbackProxy(handler) {
    if (!handler) {
        return;
    }
    if (!this.getAction()) {
        return handler;
    }
    var wrapped = action_space.bind(handler, action_space.createContext());
    wrapped[ORIGINAL] = handler;
    return wrapped;
};

Tracer.prototype.bindEmitter = function bindEmitter(emitter) {
    action_space.bindEmitter(emitter);
};

Tracer.prototype.slice = function slice(args) {
    var length = args.length;
    var result = [];
    for (var i = 0; i < length; i++) {
        result[i] = args[i];
    }
    return result;
};

module.exports = Tracer;