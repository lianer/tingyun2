'use strict';

/**
 * Tingyun Nodejs Agent Configuration.
 *
 * This module is used to provide more flexibility for developers.
 * The configuration in this module will override the configuration in tingyun.json.
 */
module.exports = {
    "agent_log_level": "info",
    "app_name": [
        "your app name"
    ],
    "licenseKey": "your license",
    "host": "redirect.networkbench.com",
    "port": 443,
    "ssl": true,
    "proxy": "",
    "proxy_host": "",
    "proxy_port": "",
    "proxy_user": "",
    "proxy_pass": "",
    "audit_mode": false
};