'use strict';

var shimmer = require('../../../util/shimmer.js');
var urltils = require('../../../util/urltils.js');
var logger = require('../../../util/logger').child('parsers.instrumentation.core.http');
var recordWeb = require('../../../metrics/recorders/http.js');
var recordExternal = require('../../../metrics/recorders/http_external.js');
var querystring = require('querystring');
var util = require('util');
var status = require('../../status/status');
var common = require('../../common');
var WebActionNaming = require('../../../metrics/normalizer/customized');
var utils = require('../../../util/util.js');

function set_header(r, nm, vl) {
    try {
        if (r.setHeader(nm, vl)) {
            return;
        }
    } catch (e) {}
    if (r._headerNames) {
        r._headerNames[nm] = nm;
    }
    if (r._headers) {
        r._headers[nm] = vl;
    }
    if (r._header && r._header.length) {
        r._header = r._header.slice(0, r._header.length - 2) + nm + ': ' + vl + '\r\n\r\n';
    }
}

function getR(item, offset) {
    var end;
    return item.slice(offset, (end = item.indexOf(';', offset)) > -1 ? end : item.length);
}

function isSlowAction(action) {
    var agent = action.agent;
    var traces = agent.traces;
    if (traces.trace_count >= traces.top_n && duration <= traces.min_duration) {
        return false;
    }
    var actionTracer = agent.config.action_tracer;
    var limit = (typeof actionTracer.action_threshold === 'number') ? actionTracer.action_threshold : action.metrics.apdex_t * 4;
    var duration = action.getTrace().getDurationInMillis();
    return duration > limit;
}

function setTraceData(action, res) {
    if (action.trans) {
        var r = action.trans.app_id,
            traceData, offset;
        if (r && (offset = r.indexOf(';r=')) > -1) {
            r = getR(r, offset + 3);
            if (r) {
                traceData = JSON.parse(action.getTraceDurations());
                traceData.r = parseInt(r, 10);
            }
        }
        traceData = traceData || JSON.parse(action.getTraceDurations());
        if (isSlowAction(action)) {
            traceData.tr = 1;
        }
        set_header(res, 'X-Tingyun-Tx-Data', JSON.stringify(traceData));
        action.head_writed = true;
    }
}

function isSameId(a, b) {
    var bResult = b.slice(0, b.indexOf('|'));
    return bResult === a ? true : (a.slice(0, a.indexOf('|')) == bResult ? true : a.slice(0, a.indexOf(';')) == bResult);
}

function CrossAppTracking(config) {
    this.config = config;
}

CrossAppTracking.prototype.matchTransaction = function(action, req, res) {
    var xTingyunId = req.headers['x-tingyun-id'];
    if (xTingyunId && isSameId(xTingyunId, this.config.transaction_tracer.tingyunIdSecret)) {
        action.trans = {
            app_id: xTingyunId
        };
        this.setActionTransactionId(action, xTingyunId);
        return true;
    }
    return false;
};

CrossAppTracking.prototype.setActionTransactionId = function(action, xTingyunId) {
    var xStartIndex = xTingyunId.indexOf('x=');
    if (xStartIndex > -1) {
        var xEndIndex = xTingyunId.indexOf(';', xStartIndex);
        xEndIndex = xEndIndex > -1 ? xEndIndex : xTingyunId.length;
        var xValue = xTingyunId.slice(xStartIndex + 2, xEndIndex);
        action.trans.trans_id = xValue;
    }
};

CrossAppTracking.prototype.enabled = function() {
    return this.config.cross_track();
};

CrossAppTracking.prototype.on_action_enter = function(action, req, res) {
    if (!this.config.transaction_tracer.tingyunIdSecret) {
        return;
    }
    var matched = this.matchTransaction(action, req, res);
    if (matched) {
        shimmer.wrapMethod(res, 'response', ['write', 'end'], function(raw) {
            return function() {
                if (action.head_writed || this.headersSent) {
                    return raw.apply(this, arguments);
                }
                setTraceData(action, res);
                return raw.apply(this, arguments);
            }
        });
    }
};

CrossAppTracking.prototype.on_extern_request = function(action, req) {
    var xTingyunId = common.getTingyunId(action.agent, 'http', {
        p: 'http'
    });
    xTingyunId && req.setHeader('X-Tingyun-Id', xTingyunId);
};

CrossAppTracking.prototype.on_extern_response = function(segment, res) {
    var txData;
    if (!this.enabled()) {
        return;
    }
    if (!(txData = res.headers['x-tingyun-tx-data'])) {
        return;
    }
    var action = segment.trace.action;
    try {
        txData = JSON.parse(txData);
    } catch (e) {
        try {
            // handle python single quote.
            txData = JSON.parse(txData.replace(/'/g, '"'));
        } catch (ex) {
            // error again, then ignore it.
            txData = null;
        }
    }
    if (txData) {
        if (txData.tr) {
            action.forceActionTrace = true;
        }
        segment.parameters.txData = txData;
        segment.parameters.txId = action.trans && action.trans.trans_id ? action.trans.trans_id : action.id;
    }
};

var tracking;

function wrapExternal(agent, request, hostname, port, href, protocol) {
    if (!hostname) {
        throw new Error("hostname must be defined!");
    }
    if (!port || port < 1) {
        throw new Error("port must be defined!");
    }
    if (port && ((protocol === 'http' && port !== 80) || (protocol === 'https') && port !== 443)) {
        hostname = hostname + ':' + port;
    }

    var action = agent.tracer.getAction();
    tracking.on_extern_request(action, request);

    var params = urltils.parseParameters(request.path);
    var requestPath = urltils.scrub(request.path);

    var baseUrl = protocol + "://" + hostname;

    var rewritenPath;
    var externalUrlParamsNamingRules = agent.config.externalUrlParamsNamingRules;
    if (externalUrlParamsNamingRules) {
        rewritenPath = common.namingByUriPrams({
            host: baseUrl,
            path: requestPath
        }, params, null, request._headers, externalUrlParamsNamingRules);
    }

    var trans_url = baseUrl + (rewritenPath || requestPath);
    var name = 'External/' + trans_url.replace(/\//g, "%2F") + "/request";
    var segment_info = {
        metric_name: name,
        call_url: (href ? href : (request.url ? request.url() : baseUrl + request.path)),
        call_count: 1,
        class_name: "ClientRequest",
        method_name: "request",
        params: {}
    };
    var segment = agent.tracer.addSegment(segment_info, recordExternal(trans_url, protocol));

    urltils.copyParameters(agent.config, params, segment.parameters);

    request.once('error', function __handleRequestError(error) {
        var statusCode = status(error.code) || 1000;
        var res = segment.externalResponse = segment.externalResponse || {};
        res.statusCode = statusCode;
        res.statusMessage = error.message || error.code;
        error.name = error && error.constructor && error.constructor.name;
        res.error = error;
        res.requestParams = getParameters(this);
        segment.end();
    });

    var existingListeners = request.listeners('response').slice();
    request.removeAllListeners('response');

    request.on('response', function __handleResponse(res) {
        var statusCode = res.statusCode;
        if (filterStatus(statusCode)) {
            var error = new Error('Http Request Error' + statusCode);
            error.name = 'External ' + statusCode;
            segment.externalResponse = {
                statusCode: statusCode,
                statusMessage: res.statusMessage,
                requestParams: getParameters(this),
                error: error
            };
        }
        tracking.on_extern_response(segment, res);
        segment.touch();
        res.once('end', function __requestOnEnd() {
            segment.end();
        });
    });

    for (var i = 0; i < existingListeners.length; i++) {
        request.on('response', existingListeners[i]);
    }

    agent.tracer.bindEmitter(request);
}

function getParameters(request) {
    var path = request.path;
    var index;
    if (path && (index = path.indexOf('?')) > -1) {
        return querystring.parse(path.substr(index + 1));
    }
    return {};
}

function filterStatus(statusCode) {
    return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 600 && statusCode != 401
}

function canEmbed(rum, headers) {
    if (!rum.enabled) {
        logger.debug('disabled rum!');
        return false;
    }
    if (rum.ratio <= Math.random(0, 1)) {
        logger.debug('ratio missed!');
        return false;
    }
    if (!rum.script) {
        logger.debug('empty body of script!');
        return false;
    }

    if (!headers) {
        logger.debug('no request headers!');
        return false;
    }
    if (headers['x-requested-with']) {
        logger.debug('skip xhr request!');
        return false;
    }

    return true;
}

function append(field, val) {
    var prev = this.getHeader(field);
    var value = val;

    if (prev) {
        // concat the new and prev vals
        value = Array.isArray(prev) ? prev.concat(val) :
            Array.isArray(val) ? [prev].concat(val) :
            [prev, val];
    }

    return this.setHeader(field, value);
}

function wrapListener(agent, listener) {
    if (!listener) {
        throw new Error("No request listener defined, so nothing to do.");
    }

    var tracer = agent.tracer;

    return tracer.actionProxy(function wrappedHandler(request, response) {
        var action;
        var config = agent.config;
        if (!config.enabled || !(action = tracer.getAction())) {
            return listener.apply(this, arguments);
        }

        tracer.bindEmitter(request);
        tracer.bindEmitter(response);

        var method = request.method;
        var headers = request.headers;

        var url = request.originalUrl || request.url;
        action.originalUrl = url;
        action.url = urltils.scrub(url);
        action.verb = method;

        var rum = config.rum;
        if (canEmbed(rum, headers)) {
            var wrapWriteResponse = function(original, rum) {
                return function(chunk, encoding, callback) {
                    if (this.headersSent) {
                        logger.debug('%s: headers has been sent!', action.url);
                        return original.call(this, chunk, encoding, callback);
                    }
                    if (this.statusCode != 200) {
                        logger.debug('%s: statusCode is %s, skip embedding!', action.url, this.statusCode);
                        return original.call(this, chunk, encoding, callback);
                    }
                    if (action.embedded) {
                        logger.debug('%s: already embedded!', action.url);
                        return original.call(this, chunk, encoding, callback);
                    }

                    if (rum['mix_enabled']) {
                        logger.debug('mixed mode');
                        append.call(this, 'Set-Cookie', 'TINGYUN_DATA=' + getServerMetrics(action, true));
                        action.embedded = true;
                        logger.debug('%s: set cookie in mixed mode', action.url);
                        return original.call(this, chunk, encoding, callback);
                    }

                    var contentType = this.getHeader('content-type');
                    if (contentType && contentType.indexOf('text/html') < 0) {
                        logger.debug('%s: content-type unmatched!', action.url);
                        return original.call(this, chunk, encoding, callback);;
                    }

                    var contentEncoding = this.getHeader('content-encoding');
                    if (contentEncoding && CONTENT_ENCODING_TYPE.indexOf(contentEncoding) > -1) {
                        logger.debug('%s: content-encoding(%s) unmatched(compressed)!', action.url, contentEncoding);
                        return original.call(this, chunk, encoding, callback);;
                    }

                    if (typeof chunk === 'function') {
                        callback = chunk;
                        chunk = null;
                    } else if (typeof encoding === 'function') {
                        callback = encoding;
                        encoding = null;
                    }

                    if (!chunk) {
                        return original.call(this, chunk, encoding, callback);
                    }
                    var decodeChunk;
                    if (chunk instanceof Buffer) {
                        decodeChunk = chunk.toString(encoding);
                    } else if (typeof chunk === 'string') {
                        decodeChunk = chunk;
                    }

                    var matchedPoint = chunkMatched(this, decodeChunk, action);
                    if (matchedPoint === false) {
                        return original.call(this, chunk, encoding, callback);
                    }

                    var script = getBrowserAgentScript(rum.script, getServerMetrics(action));
                    decodeChunk = decodeChunk.substr(0, matchedPoint) + script + decodeChunk.substr(matchedPoint);
                    action.embedded = true;
                    var contentLength = this.getHeader('Content-Length');
                    if (contentLength !== undefined) {
                        contentLength = parseInt(contentLength, 10) || 0;
                        var newLength = contentLength + Buffer.byteLength(script, encoding);
                        logger.debug('change content-type from %s to %s', contentLength, newLength);
                        this.setHeader("Content-Length", newLength);
                    }
                    logger.debug('%s: embedded browser script successfully.', action.url);
                    return original.call(this, decodeChunk, encoding, callback);
                }
            };

            var end = response.end;
            response.end = wrapWriteResponse(end, rum);

            var write = response.write;
            response.write = wrapWriteResponse(write, rum);
        }

        action.block_time = 0;
        if (typeof headers['x-queue-start'] === 'string') {
            var http_proxy_time;
            var time_obj = querystring.parse(headers['x-queue-start']);
            if (time_obj.s) {
                http_proxy_time = time_obj.s * 1000;
            }
            if (time_obj.t) {
                http_proxy_time = time_obj.t / 1000;
            }
            action.block_time = Date.now() - http_proxy_time;
            if (action.block_time < 0) {
                action.block_time = 0;
            }
        }
        var parentSegmentInfo = {
            metric_name: "NodeJS/NULL/" + action.url.replace(/\//g, "%2F"),
            call_url: "",
            call_count: 1,
            class_name: "listener",
            method_name: "request",
            params: {}
        };

        var segment = tracer.addSegment(parentSegmentInfo, recordWeb);

        var rules = config.naming.rules;
        if (rules && rules.length) {
            action.webActionNamer = new WebActionNaming({
                method: method,
                url: url,
                headers: headers
            }, rules);
        }

        tracking.on_action_enter(action, request, response);

        response.once('finish', function onResponseFinish() {
            action.query = request.query;
            if (!action.query || utils.isEmptyObject(action.query)) {
                action.query = getParameters({
                    path: action.originalUrl
                });
            }
            action.body = request.body;
            action.headers = headers;
            if (action.webActionNamer) {
                action.webActionNamer.body = request.body
            }
            action.setName(response.statusCode);
            action.setCustom(headers, response.statusCode);
            segment.markAsWeb(url);
            segment.end();
            action.end();
        });

        return listener.apply(this, arguments);
    });
}

var HTML_START_RE = /^\s*(<!\s*[^>]*>\s*)*\s*<html[^>]*>/i;

function chunkMatched(res, chunk, action) {
    if (!chunk) {
        logger.debug('decode chunk invalid.');
        return false;
    }
    var limit = 64 * 1024; //64k
    var cache = (res.__browserScriptCache || '') + chunk;
    if (cache.length > limit) {
        cache = cache.substr(0, limit);
        logger.debug('%s: reach limit(%s)!', action.url, limit);
    }
    res.__browserScriptCache = cache;
    if (cache.match(HTML_START_RE)) {
        var html = cache.toLowerCase();
        var pointCutIndex = html.indexOf('</head>');
        if (pointCutIndex > -1) {
            var titleIndex = html.indexOf('</title>');
            if (titleIndex > -1 && titleIndex < pointCutIndex) {
                pointCutIndex = titleIndex + 8;
            }
            return pointCutIndex;
        }
    }
    logger.debug('%s: html structure unmatched!', action.url);
    return false;
}

var CONTENT_ENCODING_TYPE = ['gzip', 'compress', 'deflate', 'br'];

function getServerMetrics(action, encode) {
    var traceInfo = JSON.parse(action.getTraceDurations());
    var serverMetrics = {
        id: traceInfo.id,
        n: traceInfo.action,
        a: parseInt(traceInfo.time.duration),
        q: parseInt(traceInfo.time.qu),
        tid: traceInfo.trId
    };
    return encode ? encodeURIComponent(JSON.stringify(serverMetrics)) : JSON.stringify(serverMetrics);
}

var SCRIPT_HEAD = '<script type="text/javascript" data-tingyun="tingyun">';
var SCRIPT_TAIL = '</script>';

function getBrowserAgentScript(browserScript, serverMetrics) {
    var position = browserScript.lastIndexOf('}');

    browserScript = browserScript.substr(0, position) +
        ';ty_rum.agent=' + serverMetrics + ';' +
        browserScript.substr(position);

    return SCRIPT_HEAD + browserScript + SCRIPT_TAIL;
}

module.exports = function initialize(agent, http, protocol) {
    if (!tracking) {
        tracking = new CrossAppTracking(agent.config);
    }
    shimmer.wrapMethod(http, 'http', 'createServer', function cb_wrapMethod(origin) {
        return function setDispatcher(requestListener) {
            agent.environment.setDispatcher('http');
            return origin.apply(this, arguments);
        };
    });

    if (http && http.Server && http.Server.prototype) {
        shimmer.wrapMethod(http.Server.prototype, 'http.Server.prototype', ['on', 'addListener'], function wp(addListener) {
            return function addListener_wrapper(type, listener) {
                if (type === 'request' && typeof listener === 'function') {
                    return addListener.call(this, type, wrapListener(agent, listener));
                }
                return addListener.apply(this, arguments);
            };
        });
    }

    function wrapLegacyRequest(agent, request) {
        return agent.tracer.segmentProxy(function wrappedLegacyRequest(method, path, headers) {
            var requested = request.call(this, method, path, headers);

            if (agent.config.enabled && agent.tracer.getAction()) {
                wrapExternal(agent, requested, this.host, this.port, null, protocol);
            }
            return requested;
        });
    }

    function wrapLegacyClient(agent, proto) {
        shimmer.wrapMethod(proto, 'http.Client.prototype', 'request', wrapLegacyRequest.bind(null, agent));
    }

    function wrapRequest(agent, request) {
        return agent.tracer.segmentProxy(function wrappedRequest(options, callback) {
            if (!agent.config.enabled) {
                return request.apply(this, arguments);
            }

            var internalOnly = (options && options.__TY__connection) || (options && options.headers && options.headers.TingYun && options.headers.TingYun === 'thrift');
            if (internalOnly) {
                options.__TY__connection = undefined;
                return request.apply(this, arguments);
            }

            if (callback && typeof callback === 'function') {
                callback = agent.tracer.callbackProxy(callback);
            }
            var action = agent.tracer.getAction();
            var outboundHeaders = {};

            var requested = request.call(this, options, callback);

            if (action && !internalOnly) {
                for (var header in outboundHeaders) {
                    if (outboundHeaders.hasOwnProperty(header)) {
                        requested.setHeader(header, outboundHeaders[header]);
                    }
                }
                var hostname = options.hostname || options.host || 'localhost';
                var port = options.port || options.defaultPort || ((protocol === 'http') ? 80 : 443);
                wrapExternal(agent, requested, hostname, port, options.href, protocol);
            }
            return requested;
        });
    }

    if (http && http.Agent && http.Agent.prototype && http.Agent.prototype.request) {
        shimmer.wrapMethod(http.Agent.prototype, 'http.Agent.prototype', 'request', wrapRequest.bind(null, agent));
    } else {
        shimmer.wrapMethod(http, 'http', 'request', wrapRequest.bind(null, agent));
    }

    var DeprecatedClient, deprecatedCreateClient;

    function clearGetters() {
        if (DeprecatedClient) {
            delete http.Client;
            http.Client = DeprecatedClient;
        }
        if (deprecatedCreateClient) {
            delete http.createClient;
            http.createClient = deprecatedCreateClient;
        }
    }

    DeprecatedClient = shimmer.wrapDeprecated(http, 'http', 'Client', {
        get: function get() {
            var example = new DeprecatedClient(80, 'localhost');
            wrapLegacyClient(agent, example.constructor.prototype);
            clearGetters();

            return DeprecatedClient;
        },
        set: function set(NewClient) {
            DeprecatedClient = NewClient;
        }
    });

    deprecatedCreateClient = shimmer.wrapDeprecated(http, 'http', 'createClient', {
        get: function get() {
            var example = deprecatedCreateClient(80, 'localhost');
            wrapLegacyClient(agent, example.constructor.prototype);
            clearGetters();

            return deprecatedCreateClient;
        },
        set: function set(newCreateClient) {
            deprecatedCreateClient = newCreateClient;
        }
    });
};