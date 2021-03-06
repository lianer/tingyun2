'use strict';

function Stats() {
    this.count = 0;
    this.total = 0;
    this.exclusive = 0;
    this.max = 0;
    this.min = 0;
    this.sumSquares = 0;
}

Stats.prototype.add = function(value, exclusiveValue) {
    if (value !== 0 && !value) {
        value = 0;
    }
    if (exclusiveValue !== 0 && !exclusiveValue) {
        exclusiveValue = value;
    }

    if (this.count > 0) {
        this.min = Math.min(exclusiveValue, this.min);
        this.max = Math.max(exclusiveValue, this.max);
    } else {
        this.min = exclusiveValue;
        this.max = exclusiveValue;
    }
    this.count++;
    this.sumSquares += (exclusiveValue * exclusiveValue);
    this.total += value;
    this.exclusive += exclusiveValue;
};

Stats.prototype.add1 = function(value, exclusiveValue) {
    if (value !== 0 && !value) {
        value = 0;
    }
    if (exclusiveValue !== 0 && !exclusiveValue) {
        exclusiveValue = value;
    }

    if (this.count > 0) {
        this.min = Math.min(value, this.min);
        this.max = Math.max(value, this.max);
    } else {
        this.min = value;
        this.max = value;
    }
    this.count++;
    this.sumSquares += (value * value);
    this.total += value;
    this.exclusive += value;
};

Stats.prototype.recordValueByBytes = function recordValueInBytes(bytes, exclusiveBytes) {
    this.add(bytes, exclusiveBytes || bytes);
};

Stats.prototype.recordValueInBytes = function recordValueInBytes(bytes, exclusiveBytes) {
    exclusiveBytes = exclusiveBytes || bytes;
    this.add(bytes / (1024 * 1024), exclusiveBytes / (1024 * 1024));
};

Stats.prototype.incrementCallCount = function incrementCallCount(count) {
    if (typeof count === 'undefined') count = 1;
    this.count += count;
};

Stats.prototype.merge = function merge(other) {
    if (other.count > 0) {
        if (this.count > 0) {
            this.min = Math.min(this.min, other.min);
            this.max = Math.max(this.max, other.max);
        } else {
            this.min = other.min;
            this.max = other.max;
        }
    }

    this.total += other.total;
    this.exclusive += other.exclusive;
    this.sumSquares += other.sumSquares;
    this.count += other.count;
};

Stats.prototype.toJSON = function toJSON() {
    return [
        this.count,
        Math.round(this.total),
        Math.round(this.exclusive),
        Math.round(this.max),
        Math.round(this.min),
        Math.round(this.sumSquares)
    ];
};

module.exports = Stats;