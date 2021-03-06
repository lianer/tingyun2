'use strict';
var fs = require('fs');
var util = require('util');
var zlib = require('zlib');

var DEBUG = 1;
var VERBOSE = 2;
var INFO = 3;
var WARNING = 4;
var ERROR = 5;
var CRITICAL = 6;

var levelFromName = {
    'debug': DEBUG,
    'verbose': VERBOSE,
    'info': INFO,
    'warning': WARNING,
    'error': ERROR,
    'critical': CRITICAL
};
var nameFromLevel = [
    "UNKNOWN",
    "DEBUG  ",
    "VERBOSE",
    "INFO   ",
    "WARNING",
    "ERROR  ",
    "CRITICAL"
];

function level_num(nameOrNum) {
    var level = ((typeof(nameOrNum) === 'string') ? levelFromName[nameOrNum.toLowerCase()] : nameOrNum);
    if (!(DEBUG <= level && level <= CRITICAL)) {
        throw new Error('invalid level: ' + nameOrNum);
    }
    return level;
}

var user_id = (typeof process.getuid === 'function') ? (',uid:' + process.getuid()) : '';

function Logger(options, module_desc) {
    var parent;
    if (module_desc) {
        parent = options;
        if (typeof module_desc !== 'string') {
            throw new TypeError('module_desc(string) required.');
        }
        this.inst = module_desc;
    } else if (!options) {
        throw new TypeError('options (object) is required');
    }
    if (!parent) {
        if (!options.level || !options.path) {
            throw new TypeError('option.level(number), option.path(string) is required');
        }
        if (!options.count) {
            options.count = 10;
        }
        if (!options.size) {
            options.size = 1024 * 1024 * 10;
        }
        if (!options.zip) {
            options.zip = true;
        }
    }
    if (parent) {
        this._level = parent._level;
        this.options = parent.options;
        this.ids = parent.ids;
    } else {
        this._level = level_num(options.level);
        this.options = options;
        this.ids = {
            pid: process.pid
        };
    }
}

var curr_date_string = function() {
    var curr_date = new Date();

    function f(n) {
        return n < 10 ? '0' + n : n;
    }

    var local_date = new Date(curr_date.getTime() - curr_date.getTimezoneOffset() * 60000)
    var msecond = curr_date.getMilliseconds();
    var msec_str = (msecond < 100) ? ((msecond < 10) ? "00" : "0") : "";
    msec_str += msecond;
    return local_date.getUTCFullYear() + '-' + f(local_date.getUTCMonth() + 1) + '-' + f(local_date.getUTCDate()) + ' ' + f(local_date.getUTCHours()) + ':' + f(curr_date.getMinutes()) + ':' + f(curr_date.getSeconds()) + '.' + msec_str;
};

function roll_file(path_name, id, max_count, cb) {
    var old_name = (id < 1) ? path_name : (path_name + "." + id);
    var new_name = path_name + "." + (id + 1);

    fs.exists(new_name, function on_exist(f_exist) {
        if (!f_exist) {
            if (id >= max_count) {
                fs.unlink(old_name, function on_unlink(err) {
                    cb(null);
                });
                return;
            }
            fs.rename(old_name, new_name, function on_rename(err) {
                cb(err);
            });
            return;
        }
        roll_file(path_name, id + 1, max_count, function cb_roll(error) {
            if (error) {
                cb(error);
                return;
            }
            fs.rename(old_name, new_name, function on_rename(err) {
                cb(err);
            });
        });
    });
}

function zip_enc(file_name, zip_file_name, cb) {
    var gzip = zlib.createGzip();
    var inp = fs.createReadStream(file_name);
    var out = fs.createWriteStream(zip_file_name);
    out.on('close', function(err) {
        cb(err);
    });
    inp.pipe(gzip).pipe(out);
}

var last_check_time = Math.round(Date.now() * 0.001);

function roll_logs(path_name, roll_count, roll_size, zip) {
    var curr_time = Math.round(Date.now() * 0.001);
    if (curr_time - last_check_time < 60) {
        return;
    }
    last_check_time = curr_time;
    fs.stat(path_name, function on_stat(error, state) {
        if (error) {
            return;
        }
        if (state.size < roll_size) {
            return;
        }
        if (zip) {
            var tmp_file = path_name + "." + last_check_time + ".tmp";
            fs.rename(path_name, tmp_file, function on_rename(err) {
                if (err) {
                    return;
                }
                roll_file(path_name + ".gz", 0, roll_count, function on_roll(err) {
                    zip_enc(tmp_file, path_name + ".gz", function on_zip(z_err) {
                        fs.unlink(tmp_file, function on_unlink(err) {
                            last_check_time = Math.round(Date.now() * 0.001);
                        });
                    });
                });
            });
        } else {
            roll_file(path_name, 0, roll_count, function on_roll(err) {
                last_check_time = Math.round(Date.now() * 0.001);
            });
        }
    });
}

function error_stack(ex) {
    var ret = ex.stack || ex.toString();
    if (ex.cause && typeof(ex.cause) === 'function') {
        var cex = ex.cause();
        if (cex) {
            ret += '\nCaused by: ' + error_stack(cex);
        }
    }
    return ret;
}

function errSerializer(err) {
    if (!err || !err.stack) return err;
    var obj = {
        message: err.message,
        name: err.name,
        stack: error_stack(err)
    };
    Object.keys(err).forEach(function(key) {
        if (err[key]) obj[key] = err[key];
    });
    return obj;
};

function safeCycles() {
    var seen = [];
    return function(key, val) {
        if (!val || typeof val !== 'object') {
            return val;
        }
        if (seen.indexOf(val) !== -1) {
            return '[Circular]';
        }
        seen.push(val);
        return val;
    };
}

function mkLogEmitter(minLevel) {
    return function() {
        if (arguments.length === 0) {
            return;
        }
        if (this._level > minLevel) {
            return;
        }
        roll_logs(this.options.path, this.options.count, this.options.size, this.options.zip);
        var name = this.inst ? this.inst : "::";
        //log format:
        //logtime (pid:,uid:) level@module
        var str = '\n' + curr_date_string() + ' (pid:' + this.ids.pid + user_id + ') ' + nameFromLevel[minLevel] + ' <' + name + '> ';
        fs.appendFile(this.options.path, str + this.format.apply(this, arguments), function cb() {});
    }
}

Logger.prototype.format = function() {
    var fields = null,
        msgArgs = [];
    if (arguments.length === 0) {
        return '';
    }
    if (arguments[0] instanceof Error) {
        fields = {
            err: errSerializer(arguments[0])
        };
        if (arguments.length > 1) {
            msgArgs = Array.prototype.slice.call(arguments, 1);
        }
    } else if (typeof(arguments[0]) === 'string') { // like printf(msg,....);
        fields = null;
        msgArgs = Array.prototype.slice.call(arguments);
    } else if (Buffer.isBuffer(arguments[0])) { // `log.<level>(buf, ...)`
        fields = null;
        msgArgs = Array.prototype.slice.call(arguments);
        msgArgs[0] = util.inspect(msgArgs[0]);
    } else { // `log.<level>(fields, msg, ...)`
        fields = arguments[0];
        msgArgs = Array.prototype.slice.call(arguments, 1);
    }
    var result = '';
    if (fields) {
        result += JSON.stringify(fields, safeCycles()) + ((msgArgs.length > 0) ? ',' : '');
    }
    if (msgArgs.length > 0) {
        result += util.format.apply(this, msgArgs);
    }
    return result;
};

Logger.prototype.append = function(data) {
    fs.appendFile(this.options.path, this.format.apply(this, arguments), function cb() {});
    return true;
};

Logger.prototype.enabled = function(level) {
    return (this._level <= level_num(level));
};

Logger.prototype.child = function(options) {
    return new Logger(this, options || {});
};

Logger.prototype.debug = mkLogEmitter(DEBUG);
Logger.prototype.verbose = mkLogEmitter(VERBOSE);
Logger.prototype.info = mkLogEmitter(INFO);
Logger.prototype.warning = mkLogEmitter(WARNING);
Logger.prototype.error = mkLogEmitter(ERROR);
Logger.prototype.critical = mkLogEmitter(CRITICAL);

module.exports = Logger;