const fs = require('fs');
const h = fs.readFileSync('jy_test.html', 'utf8');
const m = h.match(/eval\((function\(p,a,c,k,e,d\)[\s\S]*?\})\('((?:[^'\\]|\\.)*)',(\d+),(\d+),'((?:[^'\\]|\\.)*)'\.split\('\|'\),(\d+),(\{[^}]*\})\)\)/);
if (!m) { console.log('no match'); process.exit(1); }
const fn = eval('(' + m[1] + ')');
const out = fn(m[2], +m[3], +m[4], m[5].split('|'), +m[6], eval('(' + m[7] + ')'));
console.log(out);
