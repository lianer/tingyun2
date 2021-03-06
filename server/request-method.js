'use strict';

var util = require('util');
var url = require('url');
var http = require('http');
var https = require('https');
var deflate = require('zlib').deflate;
var logger = require('../util/logger.js').child('server.request-method');
var EventEmitter = require('events').EventEmitter;

var PROTOCOL_VERSION = '1.4.0';

function Sink(callback) {
    EventEmitter.call(this);
    this.callback = callback;
    this.sink = '';
    this.writable = true;
    var sink = this;
    this.on('error', function handle_error(error) {
        sink.writable = false;
        callback(error);
    });
}

util.inherits(Sink, EventEmitter);

Sink.prototype.write = function write(string) {
    if (!this.writable) {
        this.emit('error', new Error("Sink no longer writable!"));
        return false;
    }
    this.sink += string.toString();
    return true;
};

Sink.prototype.end = function end() {
    this.writable = false;
    this.callback(null, this.sink);
};

Sink.prototype.destroy = function destroy() {
    this.emit('close');
    this.writable = false;
    delete this.sink;
};

function default_port(ssl) {
    return ssl ? 443 : 80;
}

function RequestMethod(host, config, req_method) {
    this.request_method = req_method;
    this._config = config;
    this._host = host;
    if (this._host && typeof this._host.port === 'undefined') {
        this._host.port = default_port(this._config.ssl);
    }
}

function parse(config, name, response, callback) {
    return function responseParser(error, body) {
        var json;
        var result;
        if (error) {
            error.statusCode = code;
            return callback(error, result, json);
        };
        var code = response.statusCode;
        var http_code = (code - code % 100) / 100;
        if (body && http_code === 2) {
            var loged;
            try {
                json = JSON.parse(body);
                result = json.result;
            } catch (err) {
                error = err;
                json = {};
            }

            if (json.status === 'success') {
                logger.info('Response from %s {status: %s, code: %d}\n\t', name, 'success', code);
            } else {
                logger.info('Response from %s\n\t', name);
            }

            if (config.audit_mode === true && logger.enabled('info')) {
                loged = logger.append(body);
            }

            if ((!loged) && logger.enabled('debug')) {
                loged = logger.append(body);
            }

            if (json.status !== 'success' && !loged) {
                loged = logger.append(body);
            }
        } else {
            logger.error('%s return HTTP %s.', name, code, (http_code === 2) ? body : '');
            error = new Error(util.format('HTTP %s Error on %s.', code, name));
        }
        if (error) {
            error.statusCode = code;
        }
        callback(error, result, json);
    };
};

RequestMethod.prototype.invoke = function call(payload, callback) {
    if (!payload) {
        payload = [];
    }
    var data;
    try {
        data = JSON.stringify(payload);
    } catch (error) {
        logger.error(error, "%s data serialize error.", this.request_method);
        return process.nextTick(function new_stack() {
            callback(error);
        });
    }
    var self = this;

    function onResponse(response) {
        response.on('end', function handle_end() {});
        response.setEncoding('utf8');
        response.pipe(new Sink(parse(self._config, self.request_method, response, callback)));
    }

    function on_error(err) {
        logger.error(err);
        callback(err);
    }
    var options = {
        compressed: true, //this._config.compress ? true: false,
        path: this._uri(),
        onError: on_error,
        onResponse: onResponse
    };
    logger.info("Post http%s://%s%s\n\t", this._config.ssl ? 's' : '', this._hostname(), options.path);
    var loged;
    if (this._config.audit_mode === true && logger.enabled('info')) loged = logger.append(data);
    if (!loged && logger.enabled('debug')) loged = logger.append(data);
    if (options.compressed) {
        deflate(data, function cb_deflate(err, deflated) {
            if (err) {
                logger.warning(err, "zlib compressing failed, uncompressed data send.");
                options.body = data;
            } else {
                options.body = deflated;
            }
            self._request(options);
        });
    } else {
        options.body = data;
        this._request(options);
    }
};

RequestMethod.prototype._request = function _request(options) {
    if (!options.path) {
        return proecess.nextTick(function new_stack() {
            options.onError(new Error("Http Request Need a url！"));
        });
    }
    var requestOptions = {
        method: 'POST',
        setHost: false, // see below
        host: this._host.host,
        port: this._host.port,
        path: options.path,
        headers: this._header(options.body, options.compressed),
        __TY__connection: true // who measures the metrics measurer?
    };

    var request;
    if (this._config.ssl) {
        request = https.request(requestOptions);
    } else {
        var proxy_info = this._proxy();
        if (proxy_info.hostname && proxy_info.port) {
            requestOptions.path = 'http://' + requestOptions.host + ((requestOptions.port !== 80) ? (':' + requestOptions.port) : '') + requestOptions.path;
            requestOptions.hostname = proxy_info.hostname;
            requestOptions.port = proxy_info.port;
            requestOptions.headers['Proxy-Authorization'] = 'Basic ' + new Buffer(proxy_info.auth).toString('base64');
            request = http.request(requestOptions);
            request.on('response', function cb_on_response(sock) {
                sock.on('end', function cb_on_end() {
                    sock.destroy();
                });
            });
        } else {
            request = http.request(requestOptions);
        }
    }
    request.on('error', options.onError);
    request.on('response', options.onResponse);
    request.end(options.body);
};

RequestMethod.prototype._hostname = function _hostname() {
    return util.format("%s%s", this._host.host, (this._host.port === default_port(this._config.ssl)) ? "" : util.format(":%d", this._host.port));
};

RequestMethod.prototype._proxy = function _proxy() {
    var proxy_info;
    if (this._config.proxy) {
        proxy_info = url.parse(this._config.proxy);
    } else {
        proxy_info = {
            protocol: 'http',
            hostname: this._config.proxy_host,
            port: this._config.proxy_port,
            auth: this._config.proxy_user
        }
        if (proxy_info.auth !== '' && this._config.proxy_pass !== '') {
            proxy_info.auth += ':' + this._config.proxy_pass;
        }
    }
    return proxy_info;
};

RequestMethod.prototype._uri = function _uri() {
    var query = {
        version: PROTOCOL_VERSION,
        licenseKey: this._config.licenseKey
    };
    if (this._config.appSessionKey) {
        query['appSessionKey'] = this._config.appSessionKey;
    }
    return url.format({
        pathname: this.request_method,
        query: query
    });
};

RequestMethod.prototype._header = function _header(body, compressed) {
    var agent = util.format("TingYun-NodeAgent/%s (Node.js %s %s-%s)",
        this._config.version,
        process.versions.node,
        process.platform,
        process.arch);

    return {
        'Host': this._hostname(),
        'User-Agent': agent,
        'Connection': 'Keep-Alive',
        'Content-Length': ((body instanceof Buffer) ? body.length : Buffer.byteLength(body, 'utf8')),
        'Content-Encoding': compressed ? "deflate" : 'identity',
        'Content-Type': 'Application/json;charset=UTF-8'
    };
};

module.exports = RequestMethod;