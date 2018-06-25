var codes = require('./codes.json');

status.codes = Object.keys(codes).map(function(code) {
    var errno = codes[code];
    status[code] = status[code.toLowerCase()] = ~~errno;
    status[errno] = code;
    return code;
});

function status(code) {
    if (typeof code === 'number' || typeof code === 'string') {
        return status[code];
    }

    return null;
}

module.exports = status;