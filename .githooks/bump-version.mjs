// commit のたびにパッチ番号を 1 つ上げ、package.json と index.html の表示をそろえる
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const version = `${major}.${minor}.${patch + 1}`;

writeFileSync('package.json', readFileSync('package.json', 'utf8').replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
const html = readFileSync('index.html', 'utf8');
const updated = html.replace(/<span class="ver">v[^<]*<\/span>/, `<span class="ver">v${version}</span>`);
if (updated === html) throw new Error('index.html にバージョン表示 <span class="ver"> が見つかりません');
writeFileSync('index.html', updated);

execFileSync('git', ['add', 'package.json', 'index.html']);
console.log(`version: v${version}`);
