'use strict';

var TINGYUN_MODULE_PATH = /node_modules(\/|\\)tingyun/;

function CallStack(data, skip) {
    var obj = {};
    Error.captureStackTrace(obj);
    var stack = obj.stack;
    if (!stack) {
        return null;
    }
    stack = stack.split('\n').slice(skip ? skip + 2 : 2);
    var i, length;
    for (i = 0, length = stack.length; i < length; i++) {
        if (!TINGYUN_MODULE_PATH.test(stack[i])) {
            break;
        }
    }
    stack = stack.slice(i);
    for (i = 0, length = stack.length; i < length; i++) {
        stack[i] = stack[i].replace('    at ', '');
    }
    if (data) {
        stack.unshift(data);
    }
    return stack;
}

module.exports = CallStack;