'use strict';

var API = require('./api');
var logger = require('./util/logger.js').child('index');
require('./polyfill.js')

var agent;

var init = function init() {
    logger.info("TingYun node version %s Starting...", require('./package.json').version);
    logger.verbose("start at %s seconds.", process.uptime());

    if (process.version) {
        var version = process.version.split('.');
        if (version[0] == 'v0' && version[1] < 10) {
            logger.info("Your node version is lower than v0.10.0, please upgrate for better performance.");
        }
    }

    logger.verbose("cmdline: %s @%s", process.argv.join(' '), process.cwd());

    var config = require('./options/config.js').init();
    if (!config.enabled) {
        return "Module not enabled in configuration; not starting.";
    }
    if (!config.namecheck()) {
        return "app name checked failed. no start.";
    }

    var Agent = require('./agent.js');
    agent = new Agent(config);
    var shimmer = require('./util/shimmer.js');
    shimmer.patchModule(agent);
    shimmer.bootstrapInstrumentation(agent);
    return agent.start();
}

var start_message = init();
if (start_message !== "success") {
    logger.error(start_message);
    console.error(start_message);
}

