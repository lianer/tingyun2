var fs = require('fs');
var rootpath = require('path').join(__dirname, '../../');
var fa = require('./util/fa');
var tingyun_config = rootpath + 'tingyun.json';

process.stdin.on('end', function() {
    process.stdout.write('end');
});

function gets(tip_message, cb) {
    process.stdout.write(tip_message);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function on_data(chunk) {
        process.stdin.pause();
        process.stdin.removeListener('data', on_data);
        var result;
        if (chunk.length >= 2 && chunk.slice(chunk.length - 2) === '\r\n') {
            result = chunk.slice(0, chunk.length - 2);
        } else if (chunk.length >= 1 && chunk.slice(chunk.length - 1) === '\n') {
            result = chunk.slice(0, chunk.length - 1);
        } else {
            result = chunk;
        }
        cb(result);
    }
    process.stdin.on('data', on_data);
}

var app_name;
var license;

var config = {};

function default_val(key) {
    if (!config[key]) {
        return '';
    }
    return '(' + config[key] + ')';
}

function start() {
    gets('Please enter appname(请输入应用名称)' + default_val('app_name') + ' :', on_appname);
}

fa.readjson(tingyun_config, function on_json(error, json) {
    if (!error && typeof json === 'object') {
        config = json;
    }
    start();
});

function on_appname(result) {
    app_name = result;
    if (app_name.length < 1 && Array.isArray(config.app_name) && config.app_name.length > 0) {
        app_name = config.app_name[0];
    }
    if (!app_name.match(/^[A-Za-z0-9 -_\[\](){}?!.'"]*$/)) {
        return gets('Application name is not standardized,please re-enter appname\n(应用名不规范，请重新输入应用名称)' + default_val('app_name') + ' :', on_appname);
    }
    gets('\nPlease enter licesnse key(请输入授权码)' + default_val('licenseKey') + ' :', on_license);
}

function confirm_tip() {
    return '{' +
        '\n    app_name   : \"' + app_name + '\",' +
        '\n    licenseKey : \"' + license + '\"' +
        '\n}' +
        '\nPlease confirm input(请确认输入是否正确)Y(es) or N(o):';
}

function on_license(result) {
    license = result;
    if (license.length < 1 && config.licenseKey) {
        license = config.licenseKey;
    }
    gets(confirm_tip(), on_confirm);
}

function on_confirm(result) {
    if (result.length) {
        result = result.slice(0, 1);
    }
    if (result == 'Y' || result == 'y') {
        return make_config();
    }
    if (result == 'N' || result == 'n') {
        return start();
    }
    gets(confirm_tip(), on_confirm);
}

function make_config() {

    //写配置文件
    var writestream = fs.createWriteStream(tingyun_config, {
        flags: 'w',
        encoding: null,
        mode: 0644
    });
    if (!writestream) {
        return console.log('write ' + tingyun_config + ' error. setup failed.\n please copy node_modules/tingyun/tingyun.json to ' + tingyun_config + ' and modify it by manual, and then add \"require(\'tingyun\')\" to the first line of the index file by manual.\n');
    }
    if (!config.agent_log_level) {
        config.agent_log_level = 'info';
    }
    config.app_name = [app_name];
    config.licenseKey = license;
    config.host = 'redirect.networkbench.com';
    config.port = 443;
    config.ssl = true;
    config.proxy = '';
    config.proxy_host = '';
    config.proxy_port = '';
    config.proxy_user = '';
    config.proxy_pass = '';
    config.audit_mode = false;
    var payload = JSON.stringify(config, null, '  ');
    writestream.end(payload, 'utf8', function on_write(writed) {
        console.log(tingyun_config + ' is written. \nAdding require(\'tingyun\') to the index file...');
        on_writeconfig(null);
    });
}
var manual_tip = 'Add failed, Please add \"require(\'tingyun\')\" to the first line of the index file by manual.\n';
var setup_success = '\nAdd success(设置成功).\n';

function on_writeconfig(error) {
    //index.js is default
    var app_main = 'index.js';
    //1,从package.json中找main
    try {
        var package_json = require(rootpath + 'package.json');
    } catch (e) {}
    if (package_json && typeof package_json.main === 'string') {
        app_main = package_json.main;
    }
    //2,验证文件
    function main_file(input_file) {
        if (input_file.length === 0) {
            input_file = 'index.js';
        }
        return (input_file.charAt(0) == '/') ? input_file : (rootpath + input_file);
    }

    fs.exists(main_file(app_main), on_exist);
    var confirmed = false;

    function on_exist(exist) {

        var tip = (exist ? '' : (app_main + ' Not Found, ')) + 'Please enter app main filename(请键入应用主文件名)' + (exist ? ('(' + app_main + '):') : ':');
        if (confirmed && exist) {
            return on_index(main_file(app_main));
        }
        gets(tip, function on_app_main(result) {
            confirmed = true;
            if (result.length) {
                app_main = result;
            }
            fs.exists(main_file(app_main), on_exist);
        });
    }
}
var exec = require('child_process').exec;

function on_index(index_file) {

    var cmd = 'cat ' + index_file + ' | grep \"require(\'tingyun\')\"';
    exec(cmd, function on_exec(err, stdout, stderr) {
        if (stderr && stderr.length) {
            console.log(cmd + ' error:', stderr);
            return process.stdout.write(manual_tip);
        }
        if (stdout && stdout.length) {
            if (!stdout.match(/^[\s]*\/\//)) {
                return process.stdout.write(setup_success);
            }
        }
        return set_index(index_file);
    });
}

function set_index(index_file) {

    set_script(index_file, function(err) {
        if (err) {
            return process.stdout.write(manual_tip);
        }
        var tmpfile = rootpath + 'index.tingyun.tmp';
        var cmd = 'cat ' + index_file + ' > ' + tmpfile + ' && echo \"require(\'tingyun\');\" > ' + index_file + ' && cat ' + tmpfile + ' >> ' + index_file + ' && rm -rf ' + tmpfile;
        exec(cmd, function on_exec(err, stdout, stderr) {
            if (stderr && stderr.length) {
                console.log(cmd + ' error:', stderr);
                return process.stdout.write(manual_tip);
            }
            process.stdout.write(setup_success);
        });
    });
}

function NodeShell(re) {
    this._re = re;
}
NodeShell.prototype.check = function check(line) {
    this._re.lastIndex = 0;
    var match = this._re.exec(line);
    return match;
};
var re = new NodeShell(/^\s*#\s*!\s*\/(.*\/node)\s*/gi);
var re2 = new NodeShell(/^\s*#\s*!\s*\/(.*\/env\s*node)\s*/gi);

function set_script(index_file, callback) {
    fs.readFile(index_file, {
        encoding: 'utf-8'
    }, function on_read(err, data) {
        if (err) {
            return callback(err);
        }
        var lines = data.split('\n');
        if (lines.length) {
            var result = re.check(lines[0]);
            if (!result) {
                result = re2.check(lines[0]);
            }
            if (!result) {
                return callback(null);
            }
            var head = lines.shift();
            lines.unshift('require(\'tingyun\');');
            lines.unshift(head);
            fs.writeFile(index_file, lines.join('\n'), function cb(err) {
                process.stdout.write(setup_success);
            });
        }
    });
}