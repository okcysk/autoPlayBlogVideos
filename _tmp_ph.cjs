const fs = require('fs');
const h = fs.readFileSync('ph_test.html', 'utf8');
for (const m of h.matchAll(/"videoUrl":"((?:[^"\\]|\\.)*)"/g)) {
  console.log(JSON.parse('"' + m[1] + '"'));
}
