'use strict';

var assert = require('assert');
var wrapEmitter = require('emitter-listener');

var CONTEXTS_SYMBOL = 'cls@contexts';
var ERROR_SYMBOL = 'error@context';

if (!process.addAsyncListener) {
    require('async-listener');
}

function CallSpace(name) {
    this.name = name;
    this.active = null;
    this._set = [];
    this.id = null;
    this.cleanId = null;
}

CallSpace.prototype.set = function(key, value) {
    if (this.active) {
        this.active[key] = value;
        return value;
    }
    throw new Error("No context available. ns.run() or ns.bind() must be called first.");
};

CallSpace.prototype.get = function(key) {
    return this.active ? this.active[key] : undefined;
};

CallSpace.prototype.createContext = function() {
    return Object.create(this.active);
};

CallSpace.prototype.run = function(fn) {
    var context = this.createContext();
    this.enter(context);
    try {
        fn(context);
        return context;
    } catch (exception) {
        try {
            exception[ERROR_SYMBOL] = context;
        } catch (e) {}
        throw exception;
    } finally {
        this.leave(context);
    }
};

CallSpace.prototype.bind = function(fn, context) {
    if (!context) {
        context = this.active ? this.active : Object.create(this.active);
    }
    var self = this;
    return function() {
        self.enter(context);
        try {
            return fn.apply(this, arguments);
        } catch (exception) {
            try {
                exception[ERROR_SYMBOL] = context;
            } catch (e) {
                // when exception is falsy value or string under strict mode, ignore it.
            }
            throw exception;
        } finally {
            self.leave(context);
        }
    };
};

CallSpace.prototype.enter = function(context) {
    if (context) {
        this._set.push(this.active);
        this.active = context;
    }
};

CallSpace.prototype.leave = function(context) {
    assert.ok(context, "context must be provided for exiting");

    if (this.active === context) {
        assert.ok(this._set.length, "can't remove top context");
        this.active = this._set.pop();
        return;
    }
    var index = this._set.lastIndexOf(context);
    if (index < 0) {
        //assert.ok(index >= 0, "context not currently entered; can't leave");
        return;
    }
    assert.ok(index, "can't remove top context");
    this._set.splice(index, 1);
};

CallSpace.prototype.clean = function() {
    var self = this;
    this.cleanId = setInterval(function() {
        var toBeRemoved = [];
        self._set.forEach(function(context, index) {
            var action = context && context['action'];
            if (action && (!action.isActive() || action.passDeadline())) {
                toBeRemoved.push(index);
            }
        });

        var context;
        for (var i = toBeRemoved.length - 1; i >= 0; i--) {
            context = self._set[toBeRemoved[i]];
            if (context) {
                context.__proto__ = Object.prototype;
                self._set.splice(toBeRemoved[i], 1);
            }
        }
    }, 1000 * 60);
};

CallSpace.prototype.bindEmitter = function(emitter) {
    assert.ok(emitter.on && emitter.addListener && emitter.emit, "can only bind real EEs");
    var namespace = this;
    var thisSymbol = 'context@' + this.name;

    function attach(listener) {
        if (!listener) {
            return;
        }
        if (!listener[CONTEXTS_SYMBOL]) {
            listener[CONTEXTS_SYMBOL] = Object.create(null);
        }
        listener[CONTEXTS_SYMBOL][thisSymbol] = {
            namespace: namespace,
            context: namespace.active
        };
    }

    function bind(unwrapped) {
        if (!(unwrapped && unwrapped[CONTEXTS_SYMBOL])) {
            return unwrapped;
        }
        var wrapped = unwrapped;
        var contexts = unwrapped[CONTEXTS_SYMBOL];
        delete unwrapped[CONTEXTS_SYMBOL];
        Object.keys(contexts).forEach(function(name) {
            var thunk = contexts[name];
            wrapped = thunk.namespace.bind(wrapped, thunk.context);
        });
        return wrapped;
    }

    wrapEmitter(emitter, attach, bind);
};
CallSpace.prototype.fromException = function(exception) {
    return exception && exception[ERROR_SYMBOL];
};

var call_spaces;

function create(name) {
    assert.ok(name, "namespace must be given a name!");

    var result = new CallSpace(name);
    result.id = process.addAsyncListener({
        create: function() {
            return result.active;
        },
        before: function(context, storage) {
            if (storage) {
                result.enter(storage);
            }
        },
        after: function(context, storage) {
            if (storage) {
                result.leave(storage);
            }
        },
        error: function(storage) {
            if (storage) {
                result.leave(storage);
            }
        }
    });

    call_spaces[name] = result;
    return result;
}

function destroy(name) {
    var space = call_spaces[name];
    if (space && space.id) {
        process.removeAsyncListener(space.id);
        call_spaces[name] = null;
    }
}

function reset() {
    if (call_spaces) {
        for (var name in call_spaces) {
            destroy(name);
        }
    }
    call_spaces = Object.create(null);
}
if (!call_spaces) {
    reset();
}

module.exports = create;