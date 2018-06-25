'use strict';
var fs = require('fs');
var util = require('util');

function ModifyChecker(filename) {
    this.init = function init() {
        if (!filename) {
            return;
        }
        if ( this._last_modify ) return;
        var self = this;
        return fs.stat(filename, function on_stat(error, stat){
            if ( error ) return;
            self._last_modify = stat.mtime.getTime();
        });
    }
    this.check = function check(callback) {
        if (!filename) {
            return;
        }
        var self = this;
        return fs.stat(filename, function on_stat(error, stat){
            if ( error ) return callback(error);
            var result = stat.mtime.getTime() !== self._last_modify;
            self._last_modify = stat.mtime.getTime();
            callback(null, result);
        });
    }
}

module.exports = {
    readjson : function read(filepath, callback) {
        return fs.readFile(filepath, function on_read(error, data){
            if ( error ) return callback(error);
            try { var json = JSON.parse(data); }
            catch(e) { return callback(e); }
            return callback(null, json);
        });
    },
    state : function state(filepath, callback) {
        return fs.stat(filepath, function on_stat(error, stat){
            if ( error ) return callback(error);

        });
    },
    createChecker : function createChecker(filename) {
        return new ModifyChecker(filename);
    }

};
