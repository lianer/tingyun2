var shimmer = require('../../../util/shimmer.js');
var logger = require('../../../util/logger.js').child('parsers.wrappers.amqplib.index');
var rabbit = require('./rabbitmq');

var Promise;
try {
    Promise = require('bluebird');
} catch (e) {}

module.exports = function initialize(agent, amqp) {
    if (!amqp) {
        return logger.verbose("amqp does not exists.");
    }

    var errorHandler = rabbit.handler(agent);

    shimmer.wrapMethodOnce(amqp, 'amqp', 'connect', function(connect) {
        return function() {
            return connect.apply(this, arguments).then(function(channel) {
                return channel && wrapChannel(channel);
            }, amqpPromiseRejectionHandler);
        };
    });

    function wrapChannel(channel) {
        channel.connection && channel.connection.on('error', errorHandler);

        shimmer.wrapMethod(channel, 'ChannelModel.prototype', 'createChannel', createChannel);
        shimmer.wrapMethod(channel, 'ChannelModel.prototype', 'createConfirmChannel', createChannel);

        function createChannel(createChannel, channelType) {
            return function() {
                return createChannel.apply(this, arguments).then(function(channel) {
                    return rabbit.wrap(channel, channelType, agent);
                }, amqpPromiseRejectionHandler);
            };
        }

        return channel;
    }

    function amqpPromiseRejectionHandler(error) {
        errorHandler(error);
        if (Promise) {
            return Promise.reject(error);
        }
        throw error;
    }
};