'use strict';
var shimmer = require('../../util/shimmer');
var urltils = require('../../util/urltils.js');
var logger = require('../../util/logger').child('parsers.wrappers.thrift');
var recordExternal = require('../../metrics/recorders/http_external.js');
var recordWeb = require('../../metrics/recorders/http.js');
var common = require('../common');

module.exports = function initialize(agent, thrift) {
    if (!thrift) {
        return;
    }
    if (!(thrift.createClient && thrift.Connection && thrift.createConnection && thrift.createServer)) {
        return;
    }

    var originalSkip = thrift && thrift.TBinaryProtocol && thrift.TBinaryProtocol.prototype && thrift.TBinaryProtocol.prototype.skip;
    var tracer = agent.tracer;

    function wrap_client_method(thrift, obj_class, method) {
        shimmer.wrapMethod(thrift, 'thrift', method, function cb(createClient) {
            return tracer.segmentProxy(function wrapper(cls, connection) {
                var class_name = obj_class;
                if (typeof cls === 'string') {
                    class_name = cls;
                }
                var ret = createClient.apply(this, arguments);
                if ((!connection.host || !connection.options || !connection.port) && arguments.length > 2) {
                    connection = arguments[2];
                }
                var client = ret.__proto__;
                for (var name in client) {
                    var method_name = find_method(client, name);
                    if (method_name) {
                        if (client[method_name].__TY_original_callback) continue;
                        var oragin = client[method_name];
                        shimmer.wrapMethod(client, 'Client', method_name, function cb_method(raw_method) {
                            var __method = method_name;
                            return tracer.segmentProxy(function wrapper() {
                                if (!agent.config.enabled) {
                                    return raw_method.apply(this, arguments);
                                }
                                var action = tracer.getAction();
                                if (!action || arguments.length < 1) {
                                    return raw_method.apply(this, arguments);
                                }
                                var args = tracer.slice(arguments);
                                var last = args[args.length - 1];
                                if (typeof last !== 'function') {
                                    return raw_method.apply(this, arguments);
                                }

                                var addr = 'thrift://' + connection.host + ':' + connection.port + '/' + class_name + '.' + __method;
                                if (connection.options && connection.options.path) {
                                    addr = 'thrift://' + connection.host + ':' + connection.port + connection.options.path;
                                    connection.options.headers['TingYun'] = 'thrift';
                                }
                                var name = 'External/' + addr.replace(/\//g, "%2F") + '/' + class_name + '.' + __method;
                                var segment_info = {
                                    metric_name: name,
                                    call_url: addr,
                                    call_count: 1,
                                    class_name: class_name,
                                    method_name: __method,
                                    params: {}
                                };
                                var segment = tracer.addSegment(segment_info, recordExternal(addr, 'ThriftClient'));
                                action.thrift.segment = segment;
                                if (agent.config.transaction_tracer.thrift === true && originalSkip) {
                                    thrift.TBinaryProtocol.prototype.skip = function(action) {
                                        return _skip(action, originalSkip);
                                    }(action);
                                } else if (originalSkip) {
                                    thrift.TBinaryProtocol.prototype.skip = originalSkip;
                                }
                                args[args.length - 1] = tracer.callbackProxy(function on_back(error) {
                                    segment.end();
                                    if (error) {
                                        segment.externalResponse = {
                                            statusCode: 500,
                                            statusMessage: error.message || error.code,
                                            error: error
                                        };
                                    }
                                    return last.apply(this, arguments);
                                });
                                return raw_method.apply(this, args);
                            });
                        });
                        client[method_name].__TY_original_callback = oragin;
                    }
                }
                return ret;
            });
        });
    }

    ['Client', 'StdIOClient', 'HttpClient'].forEach(function(clientType) {
        var method = 'create' + clientType;
        if (thrift[method]) {
            wrap_client_method(thrift, clientType, method);
        }
    });

    if (thrift.Multiplexer && thrift.Multiplexer.prototype) {
        wrap_client_method(thrift.Multiplexer.prototype, 'Multiplexer', 'createClient');
    }
    if (thrift.createConnection) {
        shimmer.wrapMethod(thrift, 'thrift', 'createConnection', function cb(createConnection) {
            return function() {
                var connection = createConnection.apply(this, arguments);
                connection.on('error', function(error) {
                    var action = agent.getAction();
                    if (action) {
                        action.addExceptions(error);
                    } else {
                        logger.error('thrift createConnection error, but without action context!', error);
                    }
                });
                return connection;
            };
        });
    }
    if (thrift.TBinaryProtocol && thrift.TBinaryProtocol.prototype) {
        shimmer.wrapMethod(thrift.TBinaryProtocol.prototype, 'TBinaryProtocol.prototype', 'writeFieldStop', function cb(writeFieldStop) {
            return tracer.segmentProxy(function wrapper() {
                var config = agent.config;
                if (!config.enabled || !config.cross_track()) {
                    return writeFieldStop.apply(this, arguments);
                }
                var action = tracer.getAction();
                if (!action) {
                    return writeFieldStop.apply(this, arguments);
                }
                var data = null;
                var crossTrackingEnabled = agent.config.transaction_tracer.thrift;
                var server = action.thrift.server;
                if (server) {
                    if (!action.partialName) {
                        action.setPartialName('thrift/' + server.className + '/' + (server.methodName || 'process'));
                    }
                    action.name = "WebAction/" + action.partialName;
                    if (server.segment) {
                        server.segment.partialName = action.partialName;
                        server.segment.end();
                    }
                    if (crossTrackingEnabled && action.thrift.TingyunID && idMatch(action.thrift.TingyunID, config.transaction_tracer.tingyunIdSecret)) {
                        var traceData = action.getTraceDurations();
                        traceData = JSON.parse(traceData);
                        traceData && (traceData.action = action.name);
                        data = {
                            TingyunTxData: traceData
                        };
                    }
                    action.statusCode = 200;
                    action.end();
                } else {
                    var xTingyunId = common.getTingyunId(agent, 'thrift', {
                        p: 'thrift'
                    });
                    if (!xTingyunId) {
                        return writeFieldStop.apply(this, arguments);
                    }
                    data = {
                        TingyunID: xTingyunId
                    };
                }
                if (data) {
                    this.writeFieldBegin('TingyunField', thrift.Thrift.Type.STRING, 40000);
                    var sendData = JSON.stringify(data);
                    this.writeString(sendData);
                    this.writeFieldEnd();
                }
                return writeFieldStop.apply(this, arguments);
            });
        });

        shimmer.wrapMethod(thrift.TBinaryProtocol.prototype, 'TBinaryProtocol.prototype', 'skip', function cb(skip) {
            return _skip(null, skip);
        });
    }

    function _skip(_action, originalSkip) {
        return tracer.segmentProxy(function skipWrapper(type) {
            var action = _action || tracer.getAction();
            if (!action) {
                return originalSkip.apply(this, arguments);
            }
            if (type == thrift.Thrift.Type.STRING) {
                extractData(this.readString(), action);
                return;
            }
            return originalSkip.apply(this, arguments);
        });
    }

    if (thrift.createMultiplexServer) {
        shimmer.wrapMethod(thrift, 'thrift.createMultiplexServer', 'createMultiplexServer', function cb(createMultiplexServer) {
            return function(processor, options) {
                wrapProcessor(processor.__proto__, tracer);
                return createMultiplexServer.call(thrift, processor, options);
            }
        });
    }
    if (thrift.createServer) {
        shimmer.wrapMethod(thrift, 'thrift.createServer', 'createServer', function cb(createServer) {
            return function(processor, handler, options) {
                if (processor.Processor) {
                    wrapProcessor(processor.Processor.prototype, tracer);
                } else {
                    wrapProcessor(processor.prototype, tracer);
                }
                return createServer.call(this, processor, handler, options);
            };
        });
    }
};

function find_method(client, name) {
    if (name.indexOf('send_') === 0) {
        var search_name = name.slice(5);
        if (typeof client['recv_' + search_name] === 'function' && typeof client[search_name] === 'function') {
            return search_name;
        }
    }
}

function extractData(data, action) {
    if (!data) {
        return;
    }
    if (/TingyunTxData/i.test(data)) {
        data = safeParse(data);
        if (data && data.TingyunTxData && action.thrift.segment) {
            action.thrift.segment.parameters.txData = data.TingyunTxData;
            action.thrift.segment.parameters.txId = action.trans && action.trans.trans_id ? action.trans.trans_id : action.id;
        }
    } else if (/TingyunID/i.test(data)) {
        data = safeParse(data);
        if (data && data.TingyunID) {
            action.thrift.TingyunID = data.TingyunID;
            var xStartIndex = data.TingyunID.indexOf('x=');
            if (xStartIndex > -1) {
                var xEndIndex = data.TingyunID.indexOf(';', xStartIndex);
                xEndIndex = xEndIndex > -1 ? xEndIndex : data.TingyunID.length;
                var xValue = data.TingyunID.slice(xStartIndex + 2, xEndIndex);
                action.trans = action.trans || {};
                action.trans.trans_id = xValue;
            }
        }
    }
}

function safeParse(args) {
    var data = null;
    try {
        data = JSON.parse(args);
    } catch (e) {
        logger.error(args);
        logger.error('parse thrift data error, %s', e.message);
        data = null;
    }
    return data;
}

function wrapProcessor(processor, tracer) {
    for (var method in processor) {
        wrapService(method, processor, tracer);
    }
}

function wrapService(method, processor, tracer) {
    if (!(method.indexOf('process_') === 0 && typeof processor[method] === 'function')) {
        return;
    }
    shimmer.wrapMethod(processor, 'processor.prototype', method, function cb(processMethod) {
        var methodName = method.replace('process_', '');
        return tracer.actionProxy(function() {
            var action = tracer.getAction();
            if (!action) {
                return processMethod.apply(this, arguments);
            }
            var server = {};
            server.className = processor.constructor && processor.constructor.name || 'server_processor';
            server.methodName = methodName;
            var url = ('thrift://' + server.className + '/' + methodName).replace(/\//g, "%2F");
            var segmentInfo = {
                metric_name: "NodeJS/NULL/" + url,
                call_url: "",
                call_count: 1,
                class_name: server.className,
                method_name: methodName,
                params: {}
            };
            server.segment = tracer.addSegment(segmentInfo, recordWeb);
            action.thrift.server = server;
            action.url = url;
            return processMethod.apply(this, arguments);
        });
    });
}

function idMatch(a, b) {
    var bResult = b.slice(0, b.indexOf('|'));
    return bResult === a ? true : (a.slice(0, a.indexOf('|')) == bResult ? true : a.slice(0, a.indexOf(';')) == bResult);
}