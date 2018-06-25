'use strict';

function MetricsFormat(jobject, map, type, agent) {
    this.container = jobject;
    this.type = type;
    this.nameMap = map;
    this.agent = agent;
}

function fix_name(name, val) {
    var raw_name = val.name;
    if (raw_name && raw_name instanceof Array) {
        return {
            name: raw_name[0],
            calleeId: raw_name[1],
            calleeName: raw_name[2]
        };
    }
    return {
        name: name
    };
}

MetricsFormat.prototype.getSerializedKey = function(key) {
    return this.nameMap.map(key);
};

MetricsFormat.prototype.toJSON = function toJSON() {
    var result = [];
    for (var name in this.container) {
        var value = this.container[name];
        if (this.type === 'components') {
            for (var sub in value) {
                var key = fix_name(sub, value[sub]);
                key.parent = name;
                result.push([this.getSerializedKey(key), value[sub]]);
            }
        } else {
            var item = [this.getSerializedKey(fix_name(name, value)), value];
            if (this.type == 'action' && this.agent && this.agent.quantile && this.agent.config.quantile) {
                var q = this.agent.quantile.getResult(name);
                q && item.push(q);
            }
            result.push(item);
        }
    }
    return result;
};

module.exports = MetricsFormat;