'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bm3-startup-test-'));
const data = path.join(temporary, 'data');
const file = path.join(data, 'bm3-startup.log');
const probe = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/startup_trace.js'), 'utf8'), {
    module: probe, require, Buffer, __dirname: path.join(temporary, 'source', 'javascript')
});
try {
    probe.exports.trace('test:begin', new Error('native resource rejected'));
    let content = fs.readFileSync(file, 'utf8');
    assert(content.includes('test:begin Error: native resource rejected'));
    assert(content.includes('at '), 'error stack is retained');
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    probe.exports.trace('test:redaction', 'WBS12345678901234 12 34 56 78 90 AB CD EF 00112233445566778899AABB');
    content = fs.readFileSync(file, 'utf8');
    assert(!content.includes('WBS12345678901234'));
    assert(!content.includes('12 34 56 78 90 AB CD EF'));
    assert(!content.includes('00112233445566778899AABB'));
    for (let i = 0; i < 80; i++) probe.exports.trace('test:fill', 'message '.repeat(1024));
    assert(fs.statSync(file).size <= 64 * 1024, 'trace stays within the fixed cap');
    assert(fs.readFileSync(file, 'utf8').includes('trace:rotated'));
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.doesNotThrow(() => probe.exports.trace('test:unwritable', 'ignored'));
    // A failure loading the SDK/host is recorded before the entry rethrows.
    const stages = [];
    assert.throws(() => vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/entry.js'), 'utf8'), {
        module: { exports: {} }, console, process: {}, require(name) {
            if (name === './startup_trace') return { trace(stage) { stages.push(stage); } };
            throw new Error('Synthetic SDK loading failure');
        }
    }), /Synthetic SDK loading failure/);
    assert.deepStrictEqual(stages, ['entry:bootstrap', 'entry:load-error']);
    console.log('Startup trace verified: app-owned path, stack capture, identifier/byte redaction, 0600 permissions, 64 KiB limit, failure isolation, pre-SDK load errors.');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
