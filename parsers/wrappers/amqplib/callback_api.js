var shimmer = require('../../../util/shimmer.js');
var logger = require('../../../util/logger.js').child('parsers.wrappers.amqplib.callback_api');
var util = require('../../../util/util.js');
var rabbit = require('./rabbitmq');

module.exports = function initialize(agent, amqp) {
    if (!amqp) {
        return logger.verbose("amqp does not exists.");
    }

    var errorHandler = rabbit.handler(agent);

    shimmer.wrapMethodOnce(amqp, 'amqp', 'connect', function(connect) {
        return function() {
            var args = [].slice.call(arguments, 0);
            var callbackIndex = args.length - 1;
            var callback;
            if (callbackIndex < 0) {
                logger.debug("no arguments passed to connect method.");
            } else if (util.isFunction((callback = args[callbackIndex]))) {
                args[callbackIndex] = function(error, c) {
                    errorHandler(error);
                    c && warpModel(c);
                    return callback.apply(this, arguments);
                };
            } else {
                logger.debug("no callback function passed to connect method.");
            }
            return connect.apply(this, args);
        };
    });

    function warpModel(c) {
        c.connection && c.connection.on('error', errorHandler);

        shimmer.wrapMethod(c, 'CallbackModel.prototype', 'createChannel', createChannel);
        shimmer.wrapMethod(c, 'CallbackModel.prototype', 'createConfirmChannel', createChannel);

        function createChannel(createChannel, channelType) {
            return function(cb) {
                if (!util.isFunction(cb)) {
                    logger.debug("argument is not a function.");
                    return createChannel.apply(this, arguments);
                }
                var callback = function(error, channel) {
                    errorHandler(error);
                    if (channel) {
                        rabbit.wrap(channel, channelType, agent);
                    }
                    return cb.apply(this, arguments);
                };
                return createChannel.call(this, callback);
            };
        }
    }
};