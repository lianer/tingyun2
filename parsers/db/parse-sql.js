'use strict';

var ParsedStatement = require('./parsed-statement');

function SQLParser(op, re) {
    this._op = op;
    this._re = re;
}
SQLParser.prototype.parse = function parse(type, sql) {
    this._re.lastIndex = 0;
    if (new RegExp("^\\s*" + this._op, "ig").test(sql)) {
        var match = this._re.exec(sql);
        return new ParsedStatement(type, this._op, (match ? match[1] : 'unknown'));
    }
};

// fix me ! table name can include space char
var OPERATIONS = [
    new SQLParser('select', /^\s*select.*?\sfrom[\s\[]+([^\]\s,)(;]*).*/gi),
    new SQLParser('update', /^\s*update\s+([^\s,;]*).*/gi),
    new SQLParser('insert', /^\s*insert(?:\s+ignore)?\s+into\s+([^\s(,;]*).*/gi),
    new SQLParser('delete', /^\s*delete\s+from\s+([^\s,(;]*).*/gi)
];
var COMMENT_PATTERN = /\/\\*.*?\\*\//;

module.exports = function parseSql(type, sql) {
    sql = sql.replace(COMMENT_PATTERN, '').trim();
    for (var i = 0, length = OPERATIONS.length; i < length; i++) {
        var ps = OPERATIONS[i].parse(type, sql);
        if (ps) {
            return ps;
        }
    }
    return new ParsedStatement(type, 'other');
};