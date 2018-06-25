'use strict';

var util = require('util');
var path = require('path');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var exists = fs.existsSync || path.existsSync;
var fa = require('../util/fa');
var utils = require('../util/util');
var logger;
var feature_flag = {
    proxy: true,
    custom_instrumentation: true
};

/**
 * CONSTANTS
 */
var default_config_file = path.join(__dirname, 'config.default.js');
var defaultConfig = require(default_config_file).config;
var configFile = 'tingyun.json';
var searchLocations = [
    process.env.TINGYUN_HOME,
    process.cwd(),
    process.env.HOME,
    path.join(__dirname, '../../..')
];

// the REPL has no main module
if (process.mainModule && process.mainModule.filename) {
    searchLocations.splice(2, 0, path.dirname(process.mainModule.filename));
}

var ENV_MAPPING = {
    app_name: "TINGYUN_APP_NAME",
    licenseKey: "TINGYUN_LICENSE_KEY",
    ssl: "TINGYUN_USE_SSL",
    host: "TINGYUN_HOST",
    port: "TINGYUN_PORT",
    proxy: "TINGYUN_PROXY_URL",
    proxy_host: "TINGYUN_PROXY_HOST",
    proxy_port: "TINGYUN_PROXY_PORT",
    proxy_user: "TINGYUN_PROXY_USER",
    proxy_pass: "TINGYUN_PROXY_PASS",
    enabled: "TINGYUN_ENABLED",
    apdex_t: "TINGYUN_APDEX",
    capture_params: "TINGYUN_CAPTURE_PARAMS",
    ignored_params: "TINGYUN_IGNORED_PARAMS",
    agent_log_level: "TINGYUN_LOG_LEVEL",
    agent_log_file_name: "TINGYUN_LOG",
    logs: {
        level: "TINGYUN_LOG_LEVEL",
        filepath: "TINGYUN_LOG"
    },
    error_collector: {
        enabled: "TINGYUN_ERROR_COLLECTOR_ENABLED",
        ignored_status_codes: "TINGYUN_ERROR_COLLECTOR_IGNORE_ERROR_CODES"
    },
    action_tracer: {
        enabled: "TINGYUN_TRACER_ENABLED",
        action_threshold: "TINGYUN_TRACER_THRESHOLD",
        top_n: "TINGYUN_TRACER_TOP_N"
    },
    debug: {
        internal_metrics: "TINGYUN_DEBUG_METRICS"
    },
    rules: {
        name: "TINGYUN_NAMING_RULES",
        ignore: "TINGYUN_IGNORING_RULES"
    },
    enforce_backstop: "TINGYUN_ENFORCE_BACKSTOP"
};

// values in list variables are comma-delimited lists
var LIST_VARS = [
    "TINGYUN_APP_NAME",
    "TINGYUN_IGNORED_PARAMS",
    "TINGYUN_ERROR_COLLECTOR_IGNORE_ERROR_CODES",
    "TINGYUN_IGNORING_RULES"
];

// values in object lists are comma-delimited object literals
var OBJECT_LIST_VARS = [
    "TINGYUN_NAMING_RULES"
];

var BOOLEAN_VARS = [
    "TINGYUN_IGNORE_SERVER_CONFIGURATION",
    "TINGYUN_ENABLED",
    "TINGYUN_CAPTURE_PARAMS",
    "TINGYUN_ERROR_COLLECTOR_ENABLED",
    "TINGYUN_TRACER_ENABLED",
    "TINGYUN_DEBUG_METRICS",
    "TINGYUN_DEBUG_TRACER",
    "TINGYUN_ENFORCE_BACKSTOP",
    "TINGYUN_USE_SSL",
    "TINGYUN_BROWSER_MONITOR_ENABLE",
    "TINGYUN_BROWSER_MONITOR_DEBUG",
    "TINGYUN_HIGH_SECURITY"
];

function isTruthular(setting) {
    if (setting === undefined || setting === null) {
        return false;
    }

    var normalized = setting.toString().toLowerCase();
    switch (normalized) {
        case 'false':
        case 'f':
        case 'no':
        case 'n':
        case 'disabled':
        case '0':
            return false;

        default:
            return true;
    }
}

function fromObjectList(setting) {
    try {
        return JSON.parse('[' + setting + ']');
    } catch (error) {
        if (logger) {
            logger.error("TingYun configurator could not deserialize object list:");
            logger.error(error.stack);
        }
    }
}

function config_file_path(filename) {
    filename = filename || configFile;
    var config_file;
    for (var i = 0; i < searchLocations.length; i++) {
        if (searchLocations[i]) {
            config_file = path.join(path.resolve(searchLocations[i]), filename);
            if (exists(config_file)) {
                return fs.realpathSync(config_file);
            }
        }
    }
}

function _failHard() {
    var mainpath = path.resolve(path.join(process.cwd()));
    var altpath = path.resolve(path.dirname(process.mainModule.filename));
    var locations = (mainpath !== altpath) ? (mainpath + " or " + altpath) : mainpath;

    throw new Error(
        "Unable to find TingYun module configuration. A default\n" +
        "configuration file can be copied from " + path.join(__dirname, '../tingyun.js') + "\n" +
        "and put at " + locations + "."
    );
}

function Config(config) {
    EventEmitter.call(this);

    // 1. cloning the defaults
    var basis = JSON.parse(JSON.stringify(defaultConfig));
    for (var key in basis) {
        this[key] = basis[key];
    }

    this.feature_flag = feature_flag;

    this.config_file_path = null;
    this.appSessionKey = null;
    this.applicationId = null;
    this.web_actions_apdex = {};
    // sampling interval
    this.dataSentInterval = 50;

    this.action_tracer.record_sql = 'off';

    // 3. override defaults with values from the loaded / passed configuration
    this._allow_config(config);

    // if app name is not set, try to extract from system environment.
    this._name_fix();

    // 4. override config with environment variables
    this._fromEnvironment();

    // 5. clean up anything that requires postprocessing
    this._canonicalize();

    this.version = require('../package.json').version;

    this.webActionUriParamsNamingRules = null;
    this.externalUrlParamsNamingRules = null;
}
util.inherits(Config, EventEmitter);

Config.prototype.setLogger = function setLogger(inst) {
    logger = inst;
};

Config.prototype.update = function update(json, recursion) {
    json = json || {};
    for (var key in json) {
        this._update_config(json, key);
    }
};

Config.prototype._update_config = function _update_config(params, key) {
    switch (key) {
        case 'config':
            this.update(params[key], true);
            break;
        case 'appSessionKey':
        case 'applicationId':
            this[key] = params[key];
            this._emitIfSet(params, key);
            break;
        case 'url_rules':
        case 'metric_name_rules':
        case 'action_name_rules':
            this._emitIfSet(params, key);
            break;
        case 'ssl':
        case 'apdex_t':
        case 'web_actions_apdex':
        case 'dataSentInterval':
        case 'enabled':
            this._updateIfChanged(params, key);
            break;
        case 'nbs.capture_params':
            this._updateNestedIfChanged(params, this, key, 'capture_params');
            break;
        case 'nbs.ignored_params':
            this._updateNestedIfChanged(params, this, key, 'ignored_params');
            break;
        case 'nbs.transaction_tracer.enabled':
            this._updateNestedIfChanged(params, this.transaction_tracer, key, 'enabled');
            break;
        case 'nbs.transaction_tracer.thrift':
            this._updateNestedIfChanged(params, this.transaction_tracer, key, 'thrift');
            break;
        case 'tingyunIdSecret':
            this._updateNestedIfChanged(params, this.transaction_tracer, key, 'tingyunIdSecret');
            break;
        case 'nbs.action_tracer.enabled':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'enabled');
            break;
        case 'nbs.action_tracer.action_threshold':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'action_threshold');
            break;
        case 'nbs.action_tracer.record_sql':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'record_sql');
            break;
        case 'nbs.action_tracer.slow_sql':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'slow_sql');
            break;
        case 'nbs.action_tracer.slow_sql_threshold':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'slow_sql_threshold');
            break;
        case 'nbs.action_tracer.obfuscated_sql_fields':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'obfuscated_sql_fields');
            break;
        case 'nbs.action_tracer.explain_enabled':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'explain_enabled');
            break;
        case 'nbs.action_tracer.explain_threshold':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'explain_threshold');
            break;
        case 'nbs.action_tracer.stack_trace_threshold':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'stack_trace_threshold');
            break;
        case 'nbs.action_tracer.nbsua':
            this._updateNestedIfChanged(params, this.action_tracer, key, 'nbsua');
            break;
        case 'nbs.error_collector.enabled':
            this._updateNestedIfChanged(params, this.error_collector, key, 'enabled');
            break;
        case 'nbs.error_collector.ignored_status_codes':
            this._updateNestedIfChanged(params, this.error_collector, key, 'ignored_status_codes');
            this._canonicalize();
            break;
        case 'nbs.rum.enabled':
            this._updateNestedIfChanged(params, this.rum, key, 'enabled');
            break;
        case 'nbs.rum.mix_enabled':
            this._updateNestedIfChanged(params, this.rum, key, 'mix_enabled');
            break;
        case 'nbs.rum.script':
            this._updateNestedIfChanged(params, this.rum, key, 'script');
            break;
        case 'nbs.rum.sample_ratio':
            this._updateNestedIfChanged(params, this.rum, key, 'ratio');
            break;
        case 'nbs.naming.rules':
            var namingRules = params[key];
            try {
                namingRules = JSON.parse(namingRules);
            } catch (e) {
                if (logger) {
                    logger.debug('parsed naming rules error: ', e);
                }
                namingRules = [];
            }
            this.naming['rules'] = namingRules;
            break;
        case 'cross_application_tracing':
        case 'nbs.agent_enabled':
        case 'nbs.rum.script_url':
        case 'nbs.auto_action_naming':
            break;
        case 'nbs.quantile':
            var quantile = params[key];
            try {
                if (!utils.isString(quantile)) {
                    throw new TypeError("invalid nbs.quantile's type");
                }
                this.quantile = validateQuantileList(Array.isArray(quantile) ? quantile : JSON.parse(quantile));
                if (this.quantile) {
                    this.quantile = this.quantile.map(function(num) {
                        return num / 100;
                    });
                }
            } catch (e) {
                if (logger) {
                    logger.debug('parsed nbs.quantile error: ', e);
                }
            }
            break;
        case 'nbs.mq.enabled':
            this.mq.enabled = params[key];
            break;
        case 'nbs.external_url_params_captured':
            this.externalUrlParamsNamingRules = parseUriParams4Naming(params[key]);
            break;
        case 'nbs.web_action_uri_params_captured':
            this.webActionUriParamsNamingRules = parseUriParams4Naming(params[key]);
            break;
        case 'nbs.exception.stack_enabled':
            this.exception = this.exception || {};
            this.exception.stack_enabled = params[key];
            break;
        default:
            break;
    }
};

function parseUriParams4Naming(rules) {
    if (!rules) {
        return null;
    }
    if (!utils.isString(rules)) {
        logger.debug('invalid rules(url_rules)');
        return null;
    }
    rules = rules.split('|');
    if (!rules.length) {
        return null;
    }
    var parsed = [];
    rules.forEach(function(rule) {
        var splitedRules = rule.split(',');
        var path = splitedRules[0];
        var query = processParams(splitedRules[1]);
        var body = processParams(splitedRules[2]);
        var header = processParams(splitedRules[3]);
        parsed.push({
            path: path,
            query: query,
            body: body,
            header: header
        });
    });
    return parsed;
}

var PARAM_REG = /\[(.*)\]/;

function processParams(params) {
    var result = [];
    params = params && PARAM_REG.exec(params);
    if (!params) {
        return result;
    }
    params = params[1];
    if (!params) {
        return result;
    }
    return params.split('&');
}

function validateQuantileList(value) {
    if (!value || !Array.isArray(value) || !value.length) {
        return null;
    }
    var valid = true;
    value.reduce(function(pre, cur) {
        if (typeof pre !== 'number' || typeof cur !== 'number' || cur <= pre) {
            valid = false;
        }
        return cur;
    });
    if (!valid && logger) {
        logger.debug('nbs.quantile config is incorrect', value);
    }
    return valid ? value : null;
}

Config.prototype._updateIfChanged = function _updateIfChanged(json, key) {
    this._updateNestedIfChanged(json, this, key, key);
};

Config.prototype._updateNestedIfChanged = function _updateNestedIfChanged(remote, local, remoteKey, localKey) {
    return this._updateNestedIfChangedRaw(remote, local, remoteKey, localKey);
};

Config.prototype._updateNestedIfChangedRaw = function _updateNestedIfChangedRaw(remote, local, remoteKey, localKey) {
    var value = remote[remoteKey];
    if (value !== null && value !== undefined && local[localKey] !== value) {
        if (Array.isArray(value) && Array.isArray(local[localKey])) {
            value.forEach(function cb_forEach(element) {
                if (local[localKey].indexOf(element) === -1) local[localKey].push(element);
            });
        } else {
            local[localKey] = value;
            fixParams(local, localKey);
        }
        this.emit(remoteKey, value);
    }
};

var arrayParams = ['ignored_params', 'ignored_status_codes'];

function fixParams(config, key) {
    if (arrayParams.indexOf(key) > -1) {
        var value = config[key] = config[key] || [];
        if (typeof value === 'string') {
            config[key] = value.split(',');
        }
    }
}

/**
 * Some parameter values are just to be passed on.
 *
 * @param {object} json Config blob sent by collector.
 * @param {string} key  Value we're looking to set.
 */
Config.prototype._emitIfSet = function _emitIfSet(json, key) {
    var value = json[key];
    if (value !== null && value !== undefined) {
        this.emit(key, value);
    }
};

Config.prototype.applications = function applications() {
    var apps = this.app_name;
    if (Array.isArray(apps) && apps.length > 0) {
        return apps;
    }
    if (apps && typeof apps === 'string') {
        return [apps];
    }
    return [];
};

Config.prototype.namecheck = function namecheck() {
    var appNames = this.applications();
    if (appNames.length < 1) {
        if (logger) {
            logger.error("app name not found, start failed!");
        }
        return false;
    }
    var testVal;
    var ret = true;
    var self = this;
    appNames.forEach(function(name) {
        testVal = name.match(/^[A-Za-z0-9 -_\[\](){}?!.'"]*$/);
        if (!testVal) {
            var message = "TingYun requires that you name this application using alphanumeric" +
                " and certain punctuation characters ([](){}.?!') only.\n" +
                "Reset app_name to follow these naming conventions " +
                "in your tingyun.js file or set environment variable\n" +
                "TINGYUN_APP_NAME. Not starting!";
            self.enabled = false;
            self.emit('enabled', false);
            if (logger) logger.error(message);
            console.log(message);
            ret = false;
        }
    });
    return ret;
}

var checker = fa.createChecker(config_file_path());

Config.prototype.on_timer = function on_timer(callback) {
    var self = this;
    checker.check(function on_check(error, modifyed) {
        if (error || !modifyed) {
            return callback();
        }
        fa.readjson(config_file_path(), function on_json(error, json) {
            self._allow_config(json);
            callback();
        });
    });
}

Config.prototype._allow_config = function _allow_config(source, target) {
    if (!source) {
        return;
    }
    if (!target) {
        target = this;
    }
    for (var key in source) {
        var node = source[key];
        if (typeof node !== 'object') {
            target[key] = node;
        } else {
            this._allow_config(node, target[key]);
        }
    }
};

Config.prototype._name_fix = function _name_fix() {
    var name = this.app_name;
    if (name === null || name === undefined || name === '' || (Array.isArray(name) && name.length === 0)) {
        var env_names = process.env['APP_NAME'];
        if (env_names) {
            this.app_name = env_names.split(',');
        }
    }
};


Config.prototype._fromEnvironment = function _fromEnvironment(metadata, data) {
    if (!metadata) metadata = ENV_MAPPING;
    if (!data) data = this;

    Object.keys(metadata).forEach(function cb_forEach(value) {
        // if it's not in the config, it doesn't exist
        if (data[value] === undefined) return;

        var node = metadata[value];
        if (typeof node === 'string') {
            var setting = process.env[node];
            if (setting) {
                if (LIST_VARS.indexOf(node) > -1) {
                    data[value] = setting.split(',').map(function cb_map(k) {
                        return k.trim();
                    });
                } else if (OBJECT_LIST_VARS.indexOf(node) > -1) {
                    data[value] = fromObjectList(setting);
                } else if (BOOLEAN_VARS.indexOf(node) > -1) {
                    data[value] = isTruthular(setting);
                } else {
                    data[value] = setting;
                }
            }
        } else {
            // don't crash if the mapping has config keys the current config doesn't.
            if (!data[value]) data[value] = {};
            this._fromEnvironment(node, data[value]);
        }
    }, this);
};

/**
 * Depending on how the status codes are set, they could be strings, which
 * makes strict equality testing / indexOf fail. To keep things cheap, parse
 * them once, after configuration has finished loading. Other one-off shims
 * based on special properties of configuration values should go here as well.
 */
Config.prototype._canonicalize = function _canonicalize() {
    var codes = this.error_collector && this.error_collector.ignored_status_codes;
    if (codes) {
        this.error_collector.ignored_status_codes = codes.map(function cb_map(code) {
            return parseInt(code, 10);
        });
    }
};

//a : { b :1, c:2 } =>
//a.b : 1,
//a.c : 2
function serialize_obj(result, prefix, obj, seen) {
    seen = seen || [];
    seen.push(obj);
    for (var key in obj) {
        if (seen.indexOf(obj[key]) < 0) {
            if (obj[key] instanceof Object) {
                serialize_obj(result, prefix + key + '.', obj[key], seen);
            } else {
                result[prefix + key] = obj[key];
            }
        }
    }
    return result;
};

var obfs = {
    proxy_pass: true,
    proxy_user: true,
    proxy: true
};

Config.prototype.readsettings = function readsettings() {
    var settings = {};
    for (var key in this) {
        if (this.hasOwnProperty(key)) {
            settings[key] = obfs[key] ? '*' : this[key];
        }
    }
    settings = JSON.parse(JSON.stringify(settings));
    settings = serialize_obj({}, '', settings);
    return settings;
};

Config.prototype.cross_track = function() {
    return this.transaction_tracer.tingyunIdSecret && this.transaction_tracer.enabled;
}

function init(config) {
    if (config) {
        return new Config(config);
    }
    var jsonFilePath = config_file_path();
    var jsFilePath = config_file_path('tingyun.js');
    if (!jsonFilePath && !jsFilePath) {
        return _failHard();
    }
    var userConfig;
    if (jsonFilePath) {
        userConfig = require(jsonFilePath);
    }
    if (jsFilePath) {
        userConfig = utils.extend(userConfig, require(jsFilePath));
    }
    if (utils.isEmptyObject(userConfig)) {
        return _failHard();
    }
    try {
        var filepath = jsonFilePath || jsFilePath;
        config = new Config(userConfig);
        checker.init();
        config.config_file_path = filepath;
        return config;
    } catch (error) {
        throw new Error("Due to error " + (error && error.message) + "\n" +
            "Unable to read configuration file " + filepath + ". A default\n" +
            "configuration file can be copied from " + path.join(__dirname, '../tingyun.js') + "\n" +
            "and renamed to 'tingyun.js' in the directory from which you'll be starting\n" +
            "your application."
        );
    }
}

Config.init = init;

module.exports = Config;