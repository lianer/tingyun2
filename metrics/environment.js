'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var logger = require('../util/logger').child('metrics.environment');

var exists = fs.existsSync || path.existsSync;

function existsDir(dirPath) {
    if (!exists(dirPath)) {
        return false;
    }
    var stat = fs.statSync(dirPath);
    return stat ? stat.isDirectory() : false;
}

var remapping = {
    node_install_npm: "npm installed?",
    node_install_waf: "WAF build system installed?",
    node_use_openssl: "OpenSSL support?",
    node_shared_openssl: "Dynamically linked to OpenSSL?",
    node_shared_v8: "Dynamically linked to V8?",
    node_shared_zlib: "Dynamically linked to Zlib?",
    node_use_dtrace: "DTrace support?",
    node_use_etw: "Event Tracing for Windows (ETW) support?"
};

var values = {};

function getValue(name) {
    return values[name];
}

function setValue(name, value) {
    values[name] = value;
}

function removeValue(name) {
    delete values[name];
}

function listPackages(root) {
    var packages = [];
    if (existsDir(root)) {
        packages = fs.readdirSync(root).filter(function cb_filter(entry) {
            var candidate = path.resolve(root, entry);
            if (fs.existsSync(candidate)) {
                return fs.statSync(candidate).isDirectory() && exists(path.resolve(candidate, 'package.json'));
            }
        }).map(function cb_map(dir) {
            var pck = path.resolve(root, dir, 'package.json');
            try {
                var version = JSON.parse(fs.readFileSync(pck)).version;
            } catch (e) {
                logger.warning('Could not parse %s', pck);
            }
            return [dir, version || '<unknown>'];
        });
    }
    return packages;
}

function listDependencies(root) {
    var children = [];
    if (existsDir(root)) {
        fs.readdirSync(root).filter(function cb_filter(entry) {
            var candidate = path.resolve(root, entry);
            if (fs.existsSync(candidate)) {
                return fs.statSync(candidate).isDirectory();
            }
        }).forEach(function cb_forEach(entry) {
            var candidate = path.resolve(root, entry, 'node_modules');
            if (exists(candidate)) {
                children = children.concat(listPackages(candidate));
            }
        });
    }
    return children;
}

function getLocalPackages(start) {
    var root = path.resolve(start, 'node_modules');
    var packages = listPackages(root);
    var dependencies = listDependencies(root);
    return {
        packages: packages,
        dependencies: dependencies
    };
}

function getPackages(root) {
    var packages = [];
    var dependencies = [];

    if (exists(root)) {
        packages = listPackages(root);
        dependencies = listDependencies(root);
    }

    return {
        packages: packages,
        dependencies: dependencies
    };
}

function getGlobalPackages() {
    var packages = [];
    var dependencies = [];

    if (process.config && process.config.variables) {
        var prefix = process.config.variables.node_prefix;
        if (prefix) {
            var root = path.resolve(prefix, 'lib', 'node_modules');
            return getPackages(root);
        }
    }

    return {
        packages: packages,
        dependencies: dependencies
    };
}

function flattenVersions(packages) {
    var info = Object.create(null);
    packages.forEach(function cb_forEach(pair) {
        var p = pair[0];
        var v = pair[1];

        if (info[p]) {
            if (info[p].indexOf(v) < 0) info[p].push(v);
        } else {
            if (p) info[p] = [v];
        }
    });

    var retval = "";
    for (var key in info) {
        if (key && info[key]) {
            if (retval.length) {
                retval += ',';
            }
            retval += key + '(' + info[key] + ')';
        }
    }
    return retval;
}

function remapConfigSettings() {
    if (process.config && process.config.variables) {
        var variables = process.config.variables;
        Object.keys(variables).forEach(function cb_forEach(key) {
            if (remapping[key]) {
                var value = variables[key];
                if (value === true || value === 1) value = 'yes';
                if (value === false || value === 0) value = 'no';

                setValue(remapping[key], value);
            }
        });
    }
}

function findPackages() {
    var local = getLocalPackages(process.cwd());
    var all = getGlobalPackages();
    var other = {
        packages: [],
        dependencies: []
    };

    if (process.env.NODE_PATH) {
        var paths = process.env.NODE_PATH.split((process.platform === 'win32') ? ';' : ':');
        paths.forEach(function cb_forEach(nodePath) {
            if (nodePath[0] !== '/') {
                nodePath = path.resolve(process.cwd(), nodePath);
            }
            var nextSet = getPackages(nodePath);
            other.packages = other.packages.concat(nextSet.packages);
            other.dependencies = other.dependencies.concat(nextSet.dependencies);
        });
    }

    var packages = local.packages.concat(all.packages, other.packages);
    var dependencies = local.dependencies.concat(all.dependencies, other.dependencies);

    var home;
    var homeOld;
    if (process.platform === 'win32') {
        if (process.env.USERDIR) {
            home = getPackages(path.resolve(process.env.USERDIR, '.node_modules'));
            homeOld = getPackages(path.resolve(process.env.USERDIR, '.node_libraries'));
        }
    } else {
        if (process.env.HOME) {
            home = getPackages(path.resolve(process.env.HOME, '.node_modules'));
            homeOld = getPackages(path.resolve(process.env.HOME, '.node_libraries'));
        }
    }

    if (home) {
        packages.unshift(home.packages);
        dependencies.unshift(home.dependencies);
    }

    if (homeOld) {
        packages.unshift(homeOld.packages);
        dependencies.unshift(homeOld.dependencies);
    }

    setValue('Packages', flattenVersions(packages));
    setValue('Dependencies', flattenVersions(dependencies));
}

function badOS() {
    var badVersion = false;
    if (!process.versions) {
        badVersion = true;
    } else {
        var version = process.versions.node.split('.');
        if (version[1] < 10) {
            badVersion = true;
        }
    }
    return badVersion && os.arch() === 'x64' && os.type() === 'SunOS';
}

function getEnv() {
    if (!badOS()) {
        setValue('Processors', os.cpus().length);
    }
    setValue('OS', os.type());
    setValue('OS version', os.release());
    setValue('Node.js version', process.version);
    setValue('Architecture', process.arch);
    if ('NODE_ENV' in process.env) {
        setValue('NODE_ENV', process.env.NODE_ENV);
    }
};

function refresh() {
    var framework = getValue('Framework');
    var dispatcher = getValue('Dispatcher');
    values = {};
    if (framework) {
        setValue('Framework', framework);
    }
    if (dispatcher) {
        setValue('Dispatcher', dispatcher);
    }
    getEnv();
    remapConfigSettings();
    findPackages();
}

function toJSON() {
    refresh();
    return values;
}

refresh();

module.exports = {
    setFramework: function setFramework(framework) {
        setValue('Framework', framework);
    },
    setDispatcher: function setDispatcher(dispatcher) {
        setValue('Dispatcher', dispatcher);
    },
    listPackages: listPackages,
    toJSON: toJSON,
    get: getValue,
    refresh: refresh
};