var urlUtil = require('url');
var querystringUtil = require('querystring');
var logger = require('../../util/logger').child('metrics.normalizer.customized');

module.exports = WebActionNaming;

function WebActionNaming(req, actionNamingRules) {
    this.actionNamingRules = actionNamingRules;
    this.url = req.url;
    this.method =  req.method;
    this.cookie = null;
    this.path = null;
    this.query = null;
    this.headers = req.headers;
    this.body = null;
    this.parsed = false;
    this.matchedRule = null;
    this.name = null;
    this.splitResult = null;
}

WebActionNaming.METHODS = {
    '0': 'ALL',
    '1': 'GET',
    '2': 'POST',
    '3': 'PUT',
    '4': 'DELETE',
    '5': 'HEAD'
};

WebActionNaming.COMPARE = {
    '0': function(target, value) {
        return true;
    },
    '1': function(target, value) {
        return target == value;
    },
    '2': function(target, value) {
        return target.startsWith(value);
    },
    '3': function(target, value, ignoreSlash) {
        var matched = target.endsWith(value);
        if (matched) {
            return matched;
        }
        return ignoreSlash ? fixPath(target).endsWith(fixPath(value)) : matched;
    },
    '4': function(target, value) {
        return target.indexOf(value) > -1;
    },
    '5': function(target, value) {
        try {
            var reg = new RegExp(value);
            return reg.exec(target);
        } catch (e) {}
        return false;
    }
};

var proto = WebActionNaming.prototype = {};

proto.match = function() {
    var rules = this.actionNamingRules;
    for (var i = 0, length = rules.length; i < length; i++) {
        var rule = rules[i];
        if (!this.methodMatch(rule)) {
            logger.debug('Rule (%s): method does not match, current method is %s, rule method id is %s', rule.name, this.method, rule.match.method);
            continue;
        };
        if (!this.parsed) {
            this.parse();
        }
        if (this.valueMatch(rule)) {
            this.matchedRule = rule;
            return true;
        }
    }
    return false;
};

proto.methodMatch = function(rule) {
    var method = WebActionNaming.METHODS[rule.match.method];
    return method == 'ALL' || method == this.method ? true : false;
};

function fixPath(path) {
    if (path && !path.endsWith('/')) {
        path += '/';
    }
    return path;
}

proto.valueMatch = function(rule) {
    var path = this.path;
    var compare = WebActionNaming.COMPARE[rule.match.match];
    var rulePath = rule.match.value && rule.match.value.toLowerCase();
    var pathValueMatch = compare && compare(path, rulePath, true);
    var paramsMatch = false;
    if (pathValueMatch) {
        paramsMatch = this.paramsMatch(rule);
    } else {
        logger.debug('Rule (%s): path does not match, current path is %s, rule path is %s', rule.name, path, rulePath);
    }
    return pathValueMatch && paramsMatch;
};

var URL_PARAMETER = 1;
var HEADER_PARAMETER = 2;
var BODY_PARAMETER = 3;

proto.paramsMatch = function(rule) {
    var paramsRules = rule.match.params;
    if (paramsRules) {
        for (var i = paramsRules.length - 1; i >= 0; i--) {
            if (!this.handleParameterMatches(paramsRules[i])) {
                logger.debug('Rule (%s): %s parameters(1-url, 2-headers, 3-body) do not match', rule.name, paramsRules[i].type);
                return false;
            }
        }
    }
    return true;
};

proto.handleParameterMatches = function(paramRule) {
    switch (paramRule.type) {
        case URL_PARAMETER:
            return doParamsMatching(this.query, paramRule);
        case HEADER_PARAMETER:
            return doParamsMatching(this.headers, paramRule);
        case BODY_PARAMETER:
            return doParamsMatching(this.body, paramRule);
        default:
            return false;
    }
};

function doParamsMatching(params, rule) {
    var keys = Object.keys(params);
    var compare;
    for (var i = keys.length - 1; i >= 0; i--) {
        if (keys[i] != rule.name.toLowerCase() || !(compare = WebActionNaming.COMPARE[rule.match])) {
            continue;
        }
        var value = params[keys[i]];
        if (Array.isArray(value)) {
            for (var j = value.length - 1; j >= 0; j--) {
                if (compare(value[j], rule.value)) {
                    return true;
                }
            }
        } else {
            if (compare(value, rule.value)) {
                return true;
            }
        }
    }
    return false;
}

proto.parse = function() {
    var urlInfo = urlUtil.parse(this.url);
    this.path = urlInfo.pathname && urlInfo.pathname.toLowerCase();
    this.query = toLowerCase(querystringUtil.parse(urlInfo.query));
    this.cookie = function(cookie) {
        var result = null;
        if (cookie) {
            result = {};
            cookie.split(';').forEach(function(cookiePart) {
                var parts = cookiePart.split('=');
                result[parts[0].trim().toLowerCase()] = (parts[1] || '').trim();
            });
        }
        return result;
    }(this.headers.cookie) || {};
    this.body = toLowerCase(this.body);
    logger.debug('action parsed, %o', {
        headers: this.headers,
        path: this.path,
        query: this.query,
        cookie: this.cookie,
        body: this.body,
        method: this.method,
        url: this.url
    });
    this.parsed = true;
};

function toLowerCase(obj) {
    var result = {};
    if (obj) {
        var keys = Object.keys(obj);
        for (var i = keys.length - 1, key; i >= 0; i--) {
            key = keys[i];
            result[key] = obj[key];
        }
    }
    return result;
}

var INTEGER_REG = /^(-)?\d+$/;

proto.split = function() {
    var splitRule = this.matchedRule && this.matchedRule.split;
    if (splitRule) {
        this.splitResult = {};
        if (splitRule.uri != null) {
            if (this.path === '/') {
                this.splitResult.url = '/';
            } else {
                var urlParts = this.path.split('/');
                var urlPartIndex, urls = [];
                if (INTEGER_REG.test(splitRule.uri)) {
                    urlParts = urlParts.filter(function(part) {
                        return !!part;
                    });
                    urlPartIndex = parseInt(splitRule.uri, 10);
                    var urlPartLength = urlParts.length;
                    if (Math.abs(urlPartIndex) > urlPartLength) {
                        urlPartIndex = urlPartLength;
                    }
                    urls = urlPartIndex >= 0 ? urlParts.splice(0, urlPartIndex) : urlParts.splice(urlPartIndex + urlPartLength);
                } else {
                    splitRule.uri.split(',').forEach(function(partIndex) {
                        var part = urlParts[parseInt(partIndex, 10)];
                        part && urls.push(part);
                    });
                }
                this.splitResult.url = '/' + urls.join('/');
            }
        }

        var params = {
            urlParams: this.query,
            headerParams: this.headers,
            bodyParams: this.body,
            cookieParams: this.cookie
        };

        var paramTypes = Object.keys(params);

        for (var i = paramTypes.length - 1; i >= 0; i--) {
            var type = paramTypes[i];
            if (splitRule[type]) {
                this.splitResult[type] = splitParams(params[type], splitRule[type]);
            }
        }
    }
    return this;
};

function splitParams(params, splitParamsKey) {
    var result = {};
    var paramKeys = splitParamsKey.split(',');
    if (params) {
        for (var i = paramKeys.length - 1; i >= 0; i--) {
            var key = paramKeys[i].toLowerCase();
            if (key in params) {
                result[key] = params[key];
            }
        }
    }
    return result;
}

proto.getName = function() {
    var name = '';
    if (this.matchedRule) {
        name += this.matchedRule.name;
        if (this.splitResult && Object.keys(this.splitResult).length) {
            name += (this.splitResult.url || '');
            var params = concat(this.splitResult, ['cookieParams', 'bodyParams', 'headerParams', 'urlParams']);
            if (params) {
                name += ('?' + params);
            }
        }
        if (this.matchedRule.split && this.matchedRule.split.method) {
            name += '(' + this.method + ')';
        }
    }
    logger.debug('customized action name is, %s', name);
    return name;

    function concat(params, props) {
        var prop, paramObj, result = [];
        for (var i = props.length - 1; i >= 0; i--) {
            prop = props[i];
            paramObj = params[prop];
            if (!paramObj) {
                continue;
            }
            var keys = Object.keys(paramObj);
            for (var j = keys.length - 1, key; j >= 0; j--) {
                key = keys[j];
                result.push(key + '=' + paramObj[key]);
            }
        }
        return result.join('&');
    }
};