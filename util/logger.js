'use strict';
var Logger = require('./bunyan.js');
var config = require('../options/config.js').init();
var LEVELS = ['debug', 'verbose', 'info', 'warning', 'error', 'critical'];

function fix_level(value) {
    if (!isNaN(parseInt(value, 10)) && isFinite(value)) {
        if (value < 1) {
            value = 1;
        }
        if (value > 6) {
            value = 6;
        }
    } else if (LEVELS.indexOf(value) === -1) {
        value = 'info';
    }
    return value;
}

module.exports = new Logger({
    level: fix_level(config.agent_log_level),
    path: config.agent_log_file_name,
    count: ((typeof config.max_log_count !== 'undefined') ? config.max_log_count : 10),
    size: ((typeof config.max_log_size !== 'undefined') ? config.max_log_size : 1024 * 1024 * 10),
    zip: ((typeof config.zip_log !== 'undefined') ? config.zip_log : true)
});

config.setLogger(module.exports);