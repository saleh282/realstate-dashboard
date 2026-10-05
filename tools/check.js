'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const root = path.join(__dirname, '..');
let count = 0;
for (const folder of ['src', 'test']) {
  for (const entry of fs.readdirSync(path.join(root, folder), { recursive: true })) {
    if (!entry.endsWith('.js')) continue;
    const file = path.join(root, folder, entry);
    const code = fs.readFileSync(file, 'utf8');
    new vm.Script(code, { filename: file });
    if (folder === 'src') {
      if (/@nestjs\//.test(code)) throw new Error(`Legacy framework import: ${file}`);
      const requireFromFile = createRequire(file);
      for (const match of code.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g))
        requireFromFile.resolve(match[1]);
    }
    count++;
  }
}
console.log(`Checked ${count} JavaScript files and all application imports.`);
