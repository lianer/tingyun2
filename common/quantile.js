/*******************************************************************************
 * This implementation is modified from：
 *      http://grepcode.com/file/repo1.maven.org/maven2/com.googlecode.jasima/jasima-main/1.3.0/jasima/core/statistics/QuantileEstimator.java 
 * 
 * This file is part of jasima, v1.3, the Java simulator for manufacturing and 
 * logistics.
 *  
 * Copyright (c) 2015       jasima solutions UG
 * Copyright (c) 2010-2015 Torsten Hildebrandt and jasima contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *******************************************************************************/

/**
 * 
 * 分位值运算基于以下论文：
 * <ul>
 * <li>1. <a href=
 * "http://pierrechainais.ec-lille.fr/Centrale/Option_DAD/IMPACT_files/Dynamic%20quantiles%20calcultation%20-%20P2%20Algorythm.pdf">
 * Raj Jain, Imrich Chlamtac: The P2 Algorithm for Dynamic Calculation of
 * Quantiles and Histograms Without Storing Observations, ACM 28, 10 (1985) </a>
 * </li>
 * <li>2. <a href=
 * "http://citeseerx.ist.psu.edu/viewdoc/download?doi=10.1.1.50.6060&rep=rep1&type=pdf">
 * Kimmo Raatikainen: Simultaneous estimation of several percentiles,
 * Simulations Councils (1987) </a></li>
 * </ul>
 * 
 * @author BurningIce
 *
 */

function parseDouble(value) {
    var digit = 16;
    return Math.round(value * Math.pow(10, digit)) / Math.pow(10, digit);
}

function QuantileP2(quartileList) {
    this.quartileList = quartileList;
    this.markers_y = new Array(this.quartileList.length * 2 + 3);
    this.count = 0;
    for (var i = this.markers_y.length - 1; i >= 0; i--) {
        if (!this.markers_y[i]) {
            this.markers_y[i] = 0;
        }
    }
    this.quartileList.sort();
    this.p2_n = [];
    this.initMarkers();
}

QuantileP2.prototype.initMarkers = function() {
    var quartile_count = this.quartileList.length;
    var marker_count = quartile_count * 2 + 3;
    this.markers_x = new Array(marker_count);
    this.markers_x[0] = .0;
    this.p2_n = new Array(this.markers_y.length);
    for (var i = 0; i < quartile_count; i++) {
        var marker = this.quartileList[i];
        this.markers_x[i * 2 + 1] = (marker + this.markers_x[i * 2]) / 2;
        this.markers_x[i * 2 + 2] = marker;
    }
    this.markers_x[marker_count - 2] = (1 + this.quartileList[quartile_count - 1]) / 2;
    this.markers_x[marker_count - 1] = 1.0;
    for (var j = 0; j < marker_count; ++j) {
        // should this look at the desired marker pos?
        this.p2_n[j] = j;
    }
};

function binarySearch(a, key) {
    return binarySearch0(a, 0, a.length, key);
}

function binarySearch0(a, fromIndex, toIndex, key) {
    var low = fromIndex;
    var high = toIndex - 1;

    while (low <= high) {
        var mid = (low + high) >>> 1;
        var midVal = a[mid];

        if (midVal < key)
            low = mid + 1; // Neither val is NaN, thisVal is smaller
        else if (midVal > key)
            high = mid - 1; // Neither val is NaN, thisVal is larger
        else {
            var midBits = parseDouble(midVal);
            var keyBits = parseDouble(key);
            if (midBits == keyBits) // Values are equal
                return mid; // Key found
            else if (midBits < keyBits) // (-0.0, 0.0) or (!NaN, NaN)
                low = mid + 1;
            else // (0.0, -0.0) or (NaN, !NaN)
                high = mid - 1;
        }
    }
    return -(low + 1); // key not found.
}

QuantileP2.prototype.add = function(v) {
    if (isNaN(v)) {
        return;
    }
    var obsIdx = this.count;
    ++this.count;

    if (obsIdx < this.markers_y.length) {
        // initialization
        this.markers_y[obsIdx] = v;

        if (obsIdx == this.markers_y.length - 1) {
            // finish initialization
            this.markers_y.sort();
        }
    } else {
        // usual case
        var k = binarySearch(this.markers_y, v);
        if (k < 0) {
            k = -(k + 1);
        }

        if (k == 0) {
            this.markers_y[0] = v;
            k = 1;
        } else if (k == this.markers_y.length) {
            k = this.markers_y.length - 1;
            this.markers_y[k] = v;
        }

        for (var i = k; i < this.p2_n.length; ++i) {
            ++this.p2_n[i];
        }

        for (var i = 1; i < this.markers_y.length - 1; ++i) {
            var n_ = this.markers_x[i] * obsIdx;
            var di = n_ - this.p2_n[i];
            if ((di - 1.0 >= 0.000001 && this.p2_n[i + 1] - this.p2_n[i] > 1) || ((di + 1.0 <= 0.000001 && this.p2_n[i - 1] - this.p2_n[i] < -1))) {
                var d = di < 0 ? -1 : 1;

                var qi_ = this.quadPred(d, i);
                if (qi_ < this.markers_y[i - 1] || qi_ > this.markers_y[i + 1]) {
                    qi_ = this.linPred(d, i);
                }
                this.markers_y[i] = qi_;
                this.p2_n[i] += d;
            }
        }
    }
};

QuantileP2.prototype.markers = function() {
    if (this.count < this.markers_y.length) {
        var result = new Array(this.count);
        var markers = new Array(this.markers_y.length);
        var pw_q_copy = this.markers_y.slice();
        pw_q_copy.sort();
        for (var i = pw_q_copy.length - this.count, j = 0; i < pw_q_copy.length; i++, j++) {
            result[j] = pw_q_copy[i];
        }
        for (var i = 0; i < pw_q_copy.length; i++) {
            markers[i] = result[parseInt(Math.round((this.count - 1) * i / (pw_q_copy.length - 1)))];
        }
        return markers;
    }
    return this.markers_y;
};

QuantileP2.prototype.quadPred = function(d, i) {
    var qi = this.markers_y[i];
    var qip1 = this.markers_y[i + 1];
    var qim1 = this.markers_y[i - 1];
    var ni = this.p2_n[i];
    var nip1 = this.p2_n[i + 1];
    var nim1 = this.p2_n[i - 1];

    var a = (ni - nim1 + d) * (qip1 - qi) / (nip1 - ni);
    var b = (nip1 - ni - d) * (qi - qim1) / (ni - nim1);
    return qi + (d * (a + b)) / (nip1 - nim1);
}

QuantileP2.prototype.linPred = function(d, i) {
    var qi = this.markers_y[i];
    var qipd = this.markers_y[i + d];
    var ni = this.p2_n[i];
    var nipd = this.p2_n[i + d];

    return qi + d * (qipd - qi) / (nipd - ni);
};

module.exports = QuantileP2;