'use strict';

var os = require('os');
var logger = require('../util/logger').child('server.api');
var RequestMethod = require('./request-method.js');

function facts(agent) {
    var TypeMap = {
        string: true,
        number: true,
        boolean: true
    };

    function format_object_value(obj) {
        var ret = {};
        for (var key in obj) {
            if (TypeMap[typeof obj[key]]) {
                ret[key] = obj[key] + '';
            }
        }
        return ret;
    }
    var appName = agent.config.applications();
    appName = appName.filter(function(name) {
        return name && name.trim();
    });
    if (appName.length < 1) {
        // app name shouldn't be empty, if it does, set default value for it.
        appName = ['nodejs application'];
    }
    return {
        pid: process.pid,
        host: os.hostname(),
        appName: appName,
        language: 'Node.js',
        agentVersion: agent.config.version,
        config: format_object_value(agent.config.readsettings()),
        env: format_object_value(agent.environment.toJSON())
    };
};

function ReportServer(agent) {
    this._agent = agent;
    this._stat = 'un_start';
}

ReportServer.prototype.connect = function connect(callback) {
    var self = this;

    function retry(error, response, body) {
        if (error) {
            logger.info('error', error.message);
            if (body && body.status === 'error') {
                if (body.result && body.result.errorCode === 460) {
                    self._agent.config.enabled = false;
                    self._agent.on_enabled();
                    logger.error("tingyun stop now .");
                }
            }
        }
        return callback(error, response, body);
    }
    if (this._stat === 'un_start') {
        this._login(retry);
    } else {
        var error_string = "in connectting!";
        logger.warning("%s", error_string);
        process.nextTick(function() {
            callback(new Error(error_string));
        });
    }
};

ReportServer.prototype._login = function _login(callback) {
    var agent = this._agent;
    var redirect_req = {
        appName: agent.config.app_name
    };
    if (this._connection) {
        delete this._connection;
    }
    this._connection = new RequestMethod({
        host: agent.config.host,
        port: agent.config.port
    }, agent.config, "/getRedirectHost");
    var self = this;
    this._connection.invoke(redirect_req, function cb_invoke(error, collector, body) {
        self._stat = "un_start";
        if (error) {
            return callback(error, collector, body);
        }
        if (!collector) {
            logger.error('%s/getRedirectHost result:\n\t', agent.config.host, body);
        } else if (typeof collector === 'string') {
            var parts = collector.split(':');
            if (parts.length > 2) {
                logger.error('%s/getRedirectHost result \n\t', agent.config.host, body);
            } else {
                self.server_host = {
                    host: parts[0],
                    port: ((parts.length > 1) ? parts[1] : ((self._agent.config.ssl) ? 443 : 80))
                };
            }
        } else if (typeof collector === 'object') {
            var errorCode = collector.errorCode;
            var errorMessage = collector.errorMessage;
            return callback(new Error('dc error: errorCode is:' + errorCode + ', errorMessage is:' + errorMessage), collector, body);
        }
        if (!self.server_host) {
            return callback(new Error("ProtocolError!"), collector, body);
        }
        self._stat = "initing";
        var environment = facts(agent);
        delete self._connection;
        self._connection = new RequestMethod(self.server_host, agent.config, "/initAgentApp");
        self._connection.invoke(environment, function cb_invoke(error, config, body) {
            self._stat = 'un_start';
            if (error) {
                return callback(error, config, body);
            }
            if (body.status !== "success") {
                return callback(new Error(body.result.errorMessage), config, body);
            }
            if (!config || !config.appSessionKey) {
                return callback(new Error("No agent appSessionKey received from handshake."), config, body);
            }
            self._stat = "inited";
            agent.reconfigure(config);
            callback(null, config, body);
        });
    });
    this._stat = "redirecting";
};

ReportServer.prototype.upload = function upload(body, callback) {
    if (this._connection) {
        delete this._connection;
    }
    this._connection = new RequestMethod(this.server_host, this._agent.config, "/upload");
    this._connection.invoke(body, callback);
};

ReportServer.prototype.isConnected = function isConnected() {
    return !!this._agent.config.appSessionKey;
};

ReportServer.prototype.connectting = function connectting() {
    return this._stat !== 'un_start' && this._stat !== 'inited';
};

ReportServer.prototype.reset = function reset() {
    this._stat = 'un_start';
    if (this.server_host) {
        delete this.server_host;
    }
    if (this._connection) {
        delete this._connection;
    }
    if (this._agent.config.appSessionKey) {
        delete this._agent.config.appSessionKey;
    }
};

module.exports = ReportServer;