module.exports = {
    isFunction: function(arg) {
        return typeof arg === 'function';
    },
    extend: function(target, source) {
        if (!source || typeof source !== 'object') {
            return target;
        }
        target = target || {};
        Object.keys(source).forEach(function(key) {
            target[key] = source[key];
        });
        return target;
    },
    isEmptyObject: function(obj) {
        return Object.keys(obj).length === 0 ? true : false;
    },
    isString: function(str) {
        return typeof str === 'string';
    },
    isObject: function(obj) {
        return Object.prototype.toString.call(obj) === '[object Object]';
    },
    onlyOnce: function(fn) {
        var called = false;
        return function() {
            if (called) {
                return;
            }
            called = true;
            fn.apply(this, arguments);
        }
    },
    getErrorClassName: function getErrorClassName(error) {
        var name = error.code || error.name;
        if (name == 'Error') {
            name = null;
        }
        if (!name && error.constructor && error.constructor.name) {
            name = error.constructor.name;
        }
        return name || 'Error';
    }
};