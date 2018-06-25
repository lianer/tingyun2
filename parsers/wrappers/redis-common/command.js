var cmd_map = {
    __init: function(type, list) {
        for (var i = 0, length = list.length; i < length; i++) {
            this[list[i]] = type;
        }
    },
    __name_map: function(name) {
        var result = this[name];
        return result ? result : 'unknown';
    }
};

var get_lst = ["bitcount", "bitpos", "get", "strlen", "exists", "getbit", "getrange", "substr", "mget", "rpop", "lpop", "brpop", "blpop",
    "llen", "lindex", "lrange", "sismember", "scard", "spop", "srandmember", "sinter", "sunion", "sdiff", "smembers", "zrange", "zrangebylex",
    "zrangebyscore", "zrevrangebyscore", "zcount", "zrevrange", "zcard", "zcount", "zscore", "zlexcount", "zrank", "zrevrank", "hget", "hmget",
    "hlen", "hkeys", "hvals", "hgetall", "hexists", "randomkey", "select", "keys", "dbsize", "type", "info", "ttl", "pttl", "subscribe",
    "psubscribe", "object", "evalsha", "scan", "sscan", "hscan", "zscan", "time", "slowlog", "script exists", "pubsub", "pfcount"
];
var set_lst = ["bitop", "set", "setbit", "setnx", "setex", "psetex", "append", "brpoplpush", "rpoplpush", "setrange", "incr", "decr", "rpush",
    "lpush", "rpushx", "lpushx", "linsert", "lset", "sadd", "smove", "sinterstore", "sdiffstore", "sunionstore", "zadd", "zincrby", "zunionstore",
    "zinterstore", "hset", "hsetnx", "hmset", "hincrby", "hincrbyfloat", "incrby", "incrbyfloat", "decrby", "getset", "mset", "msetnx", "move",
    "rename", "renamenx", "persist", "unsubscribe", "punsubscribe", "publish", "watch", "unwatch", "script load", "pfmerge", "pfadd"
];
var sort_lst = ["sort", "restore", "migrate", "dump"];
var del_lst = ["del", "ltrim", "lrem", "srem", "zrem", "zremrangebyscore", "zremrangebyrank", "zremrangebylex", "hdel", "expire", "expireat",
    "pexpire", "pexpireat", "flushdb", "flushall", "script flush"
];
var ctl_lst = ["auth", "ping", "echo", "save", "bgsave", "bgrewriteaof", "shutdown", "lastsave", "multi", "exec", "discard", "sync", "monitor",
    "slaveof", "debug", "debug object", "debug segfault", "config", "cluster", "client", "script kill", "quit", "client kill", "client list",
    "client getname", "client pause", "client setname", "config get", "config rewrite", "config set", "config resetstat"
];

var script_lst = ["eval"];
cmd_map.__init('GET', get_lst);
cmd_map.__init('SET', set_lst);
cmd_map.__init('SORT', sort_lst);
cmd_map.__init('DEL', del_lst);
cmd_map.__init('CTL', ctl_lst);
cmd_map.__init('SCRIPT', script_lst);

module.exports = cmd_map;