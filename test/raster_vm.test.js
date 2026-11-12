'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { drawFrame } = require('../src/dashboard_frame');

// BMW's runner executes the linked app in runInNewContext. Plain require()
// tests miss the expensive global lookups in its per-pixel drawing loops.
const base = path.resolve(__dirname, '../src'), cache = {};
let mathReads = 0;
const globals = { Buffer, console };
Object.defineProperty(globals, 'Math', { get() { mathReads++; return Math; } });
const context = vm.createContext(globals);
function load(name) {
    const file = path.resolve(base, name + '.js');
    if (cache[file]) return cache[file].exports;
    const mod = { exports: {} }; cache[file] = mod;
    const wrapped = '(function(require,module,exports,__dirname){\n' + fs.readFileSync(file, 'utf8') + '\n})';
    vm.runInContext(wrapped, context)(dependency => dependency[0] === '.' ? load(dependency.slice(2)) : require(dependency),
        mod, mod.exports, base);
    return mod.exports;
}
const isolated = load('dashboard_frame').drawFrame;
const model = { buttons: [], status: 'Waiting for BM3', burbleTarget: 3 };
for (let page = 0; page < 5; page++) {
    const expected = drawFrame(page, {}, model, {}, null).canvas;
    const actual = isolated(page, {}, model, {}, null).canvas;
    assert(Buffer.from(actual.d).equals(Buffer.from(expected.d)), 'VM pixels match ordinary runtime on page ' + page);
}
assert(mathReads < 100, 'per-pixel Math access must not cross the VM global boundary: ' + mathReads);
console.log('Raster VM passed: identical pixels on all five pages; ' + mathReads + ' global Math reads.');
