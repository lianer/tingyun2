"use strict";

var logger = require('../util/logger').child('parsers.common');
var util = require('../util/util');

function getTingyunId(agent, protocol, params) {
    var config = agent.config;
    if (util.isObject(protocol)) {
        params = protocol;
        protocol = 'http';
    }
    switch (protocol) {
        case 'thrift':
            if (!config.transaction_tracer.thrift) {
                logger.debug('thrift transaction_tracer disabled.');
                return null;
            }
            break;
        case 'mq':
        case 'http':
        default:
            if (!config.cross_track()) {
                logger.debug('transaction_tracer disabled.');
                return null;
            }
            break;
    }
    var action = agent.getAction();
    if (!action) {
        logger.debug('action context empty.');
        return null;
    }
    var id = (action.trans ? action.trans.app_id : config.transaction_tracer.tingyunIdSecret);
    if (!id) {
        logger.debug('can not get transaction id or tingyunIdSecret value.');
        return null;
    }
    var components = {
        c: '1',
        s: new Date().getTime()
    };
    if (protocol == 'mq') {
        components.e = randomId();
    }
    components = util.extend(components, params);
    if (action.trans && action.trans.trans_id) {
        components.x = action.trans.trans_id;
    } else if (action.id) {
        components.x = action.id;
    }
    return id + ';' + serialize(components);
}

function findInTingyunId(id, searchStr) {
    if (!id) {
        logger.debug('TingyunID is null, check headers.');
        return null;
    }
    var start = id.indexOf(searchStr);
    if (start < 0) {
        return null;
    }
    var end = id.indexOf(';', start);
    if (end < 0) {
        end = id.length;
    }
    return id.substring(start + searchStr.length, end);
}

function part() {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
}

function randomId() {
    return part() + part();
}

function serialize(obj) {
    var keys = Object.keys(obj);
    var result = [];
    keys.forEach(function(key) {
        result.push(key + '=' + obj[key]);
    });
    return result.length ? result.join(';') : '';
}

function checkTransactionCondition(id, agent) {
    var valid = isSameId(id, agent.config.transaction_tracer.tingyunIdSecret);
    if (valid) {
        setActionTransactionId(agent.getAction(), id);
    }
    return valid;
}

function setActionTransactionId(action, xTingyunId) {
    if (!action) {
        return logger.debug('action context empty when setting transaction id.');
    }
    action.trans = {
        app_id: xTingyunId
    };
    var xStartIndex = xTingyunId.indexOf('x=');
    if (xStartIndex > -1) {
        var xEndIndex = xTingyunId.indexOf(';', xStartIndex);
        xEndIndex = xEndIndex > -1 ? xEndIndex : xTingyunId.length;
        var xValue = xTingyunId.slice(xStartIndex + 2, xEndIndex);
        action.trans.trans_id = xValue;
    }
}

function isSameId(a, b) {
    if (!a || !b) {
        return false;
    }
    var bResult = b.slice(0, b.indexOf('|'));
    return bResult === a ? true : (a.slice(0, a.indexOf('|')) == bResult ? true : a.slice(0, a.indexOf(';')) == bResult);
}

function getApplicationId(secret) {
    secret = secret || '';
    var start = secret.indexOf('|');
    if (start < 0) {
        return '';
    }
    var end = secret.indexOf(';', start);
    if (end < 0) {
        end = secret.length;
    }
    return secret.substring(start + 1, end);
}

function namingByUriPrams(requestUrl, query, body, header, rules) {
    var name;
    var url = requestUrl;
    if (typeof requestUrl !== 'string') {
        url = requestUrl.host + requestUrl.path;
    }
    url = completePath(url);
    rules.forEach(function(rule) {
        if (url != completePath(rule.path)) {
            return;
        }

        var matchedQuery = [];
        if (query && rule.query) {
            rule.query.forEach(function(key) {
                if (key in query) {
                    matchedQuery.push(key + '=' + query[key]);
                }
            });
        }

        var matchedBody = [];
        if (body && rule.body) {
            rule.body.forEach(function(key) {
                if (key in body) {
                    var val = body[key];
                    if (typeof val === 'string') {
                        matchedBody.push(key + '=' + body[key]);
                    } else {
                        logger.debug('typeof parameter %s in body is:%s, expected string', key, typeof val);
                    }
                }
            });
        }

        var matchedHeader = [];
        if (header && rule.header) {
            rule.header.forEach(function(key) {
                key = key.toLowerCase();
                if (key in header) {
                    matchedHeader.push(key + '=' + header[key]);
                }
            });
        }

        name = requestUrl.path || url;
        var all = matchedQuery.concat(matchedBody, matchedHeader);
        if (all.length) {
            name += '?';
            all.forEach(function(pair) {
                name += pair + '&';
            });
            name = name.substr(0, name.length - 1);
        }
    });
    return name;
}

function completePath(path) {
    return path.endsWith('/') ? path : path + '/';
}

module.exports = {
    checkTransactionCondition: checkTransactionCondition,
    getTingyunId: getTingyunId,
    findInTingyunId: findInTingyunId,
    getApplicationId: getApplicationId,
    namingByUriPrams: namingByUriPrams
};