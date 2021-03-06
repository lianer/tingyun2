'use strict';

var Timer = require('../util/timer');
var fs = require('fs');
var logger = require('../util/logger').child('common.sampler');

var cpu_time = 0;
var last_time_stamp = Date.now() - process.uptime() * 1000;
var samplers = [];

function Sampler(sampler, interval) {
    this.hTimer = setInterval(sampler, interval);
    if (this.hTimer.unref) this.hTimer.unref();
}

Sampler.prototype.stop = function stop() {
    clearInterval(this.hTimer);
};

function recordQueueTime(agent, timer) {
    timer.end();
    agent.metrics.measureMilliseconds('Events/Count/Wait', null, timer.getDurationInMillis());
}

function get_value(data, num) {
    var posion = 0;
    for (var index = 0; index < num; index++) {
        posion = data.indexOf(' ', posion);
        if (posion == -1) break;
        posion++;
    }
    if (posion !== -1) return data.slice(posion, data.indexOf(' ', posion));
}

function sampleMemory(agent) {
    return function memorySampler() {
        try {
            var mem = process.memoryUsage();
        } catch (e) {
            // too many open files, uv_resident_set_memory
            return logger.error(e.message, e);
        }
        agent.metrics.measureBytes('Memory/NULL/PhysicalUsed', mem.rss);
        if (process.platform == 'linux') {
            var file_path = '/proc/' + process.pid + '/stat';
            fs.readFile(file_path, function on_read(err, data) {
                if (err) return;
                data = data.toString();
                var cpu_ticks = parseInt(get_value(data, 13)) + parseInt(get_value(data, 14));
                var duration = (cpu_ticks - cpu_time) / 100.0;
                var now = Date.now();
                var cpu_rate = (cpu_ticks - cpu_time) * 10 / (now - last_time_stamp);
                last_time_stamp = now;
                if (cpu_rate > 1) cpu_rate = 1;
                cpu_rate *= 100;
                agent.metrics.measureMilliseconds('CPU/NULL/UserTime', null, duration, duration);
                agent.metrics.measureMilliseconds('CPU/NULL/UserUtilization', null, cpu_rate, cpu_rate);
                cpu_time = cpu_ticks;
            });
        }
    };
}

function checkEvents(agent) {
    return function eventSampler() {
        var timer = new Timer();
        timer.begin();
        setTimeout(recordQueueTime.bind(null, agent, timer), 0);
    };
}

var sampler = module.exports = {
    state: 'stopped',
    sampleMemory: sampleMemory,
    checkEvents: checkEvents,

    start: function start(agent) {
        samplers.push(new Sampler(sampleMemory(agent), 5000));
        samplers.push(new Sampler(checkEvents(agent), 15000));
        sampler.state = 'running';
    },

    stop: function stop() {
        samplers.forEach(function cb_forEach(sampler) {
            sampler.stop();
        });
        samplers = [];
        sampler.state = 'stopped';
    }
};