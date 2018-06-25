'use strict';
module.exports = {
    confusion: function confuse(sql) {
        if (sql) {
            var words = sql.split('');
            var inDoubleQuote = false;
            var inSingleQuote = false;
            var index = 0;
            words.forEach(function(char) {
                switch (char) {
                    case '"':
                        inDoubleQuote = !inDoubleQuote;
                        break;
                    case '\'':
                        inSingleQuote = !inSingleQuote;
                        break;
                    case '\r':
                    case '\t':
                    case '\n':
                        words[index] = ' ';
                        break;
                    case '0':
                    case '1':
                    case '2':
                    case '3':
                    case '4':
                    case '5':
                    case '6':
                    case '7':
                    case '8':
                    case '9':
                        words[index] = '?';
                        break;
                    default:
                        if (inDoubleQuote || inSingleQuote) {
                            words[index] = '?';
                        }
                        break;
                }
                index++;
            });
            sql = words.join('');
            sql = sql.replace(/\?+/g, '?');
        }
        return sql;
    }
};