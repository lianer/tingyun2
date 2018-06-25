/**
 * Least Recently Used (LRU) cache algorithm
 *
 *   https://github.com/rsms/js-lru
 *   https://github.com/vuejs/vue/blob/dev/src/cache.js
 *
 * @param {Number} limit
 * @constructor
 */

function LRUCache(limit) {
    this.size = 0;
    this.limit = limit;
    this.head = this.tail = undefined;
    this._data = {};
}

var proto = LRUCache.prototype;

proto.get = function(key, returnEntry) {
    var entry = this._data[key];
    if (!entry) {
        return entry;
    }
    if (entry === this.tail) {
        return returnEntry ? entry : entry.value;
    }
    if (entry.next) {
        if (this.head === entry) {
            this.head = entry.next;
        }
        entry.next.previous = entry.previous;
    }
    if (entry.previous) {
        entry.previous.next = entry.next;
    }
    entry.next = undefined;
    entry.previous = this.tail;
    if (this.tail) {
        this.tail.next = entry;
    }
    this.tail = entry;
    return returnEntry ? entry : entry.value;
};

proto.put = function(key, value) {
    var removed;
    if (this.size === this.limit) {
        removed = this.shift();
    }
    var entry = this.get(key, true);
    if (!entry) {
        entry = {
            key: key
        };
        this._data[key] = entry;
        if (this.tail) {
            this.tail.next = entry;
            entry.previous = this.tail;
        } else {
            this.head = entry;
        }
        this.tail = entry;
        this.size++;
    }
    entry.value = value;
    return removed;
};

proto.shift = function() {
    var head = this.head;
    if (head) {
        this.head = this.head.next;
        this.head.previous = undefined;
        head.next = head.previous = undefined;
        this._data[head.key] = undefined;
        this.size--;
    }
    return head;
};

proto.clear = function() {
    this.size = 0;
    this.head = this.tail = undefined;
    this._data = {};
};

module.exports = LRUCache;