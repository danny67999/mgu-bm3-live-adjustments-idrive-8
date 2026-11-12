'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { Diag } = require('../kit/diag');
const events = [], availability = [], callbacks = {};
let builds = 0, initialized = false, active = 0, maxActive = 0;
const native = {
    async callMethod(method, params, timeout) {
        active++; maxActive = Math.max(active, maxActive);
        events.push({ method, params, timeout });
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return { TasuErrorEnum: 'NO_ERROR' };
    },
    async subscribe(subscription) { callbacks[subscription.name] = subscription.onReceive; },
    async subscribeToAvailability(callback) { availability.push(callback); },
    isAvailable: () => true
};
const typed = { _someIpProxy: null, async init() { initialized = true; this._someIpProxy = native; } };
const builders = { async buildTypedProxy(iface, instance) {
    builds++;
    assert.strictEqual(iface, 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu');
    assert.strictEqual(instance, 'SystemFunctionsInternalTasuInst1');
    return typed;
} };
const probe = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../src/sdk_signals.js'), 'utf8'), {
    module: probe, setImmediate,
    require(name) { assert.strictEqual(name, 'oap-sdk/src/someip/someipBuilders'); return builders; }
});
const signals = probe.exports;
const log = { info() {}, warn() {} };
(async () => {
    const diag = new Diag(signals, log);
    await diag.init();
    assert(initialized);
    assert.strictEqual(builds, 1);
    assert.strictEqual(diag.p, native);
    assert.strictEqual(diag.available, true);
    assert.deepStrictEqual(events, [], 'building/subscribing the native SDK proxy sends no diagnostic method');
    availability[0](false);
    assert.strictEqual(diag.available, false);
    availability[0](true);
    let frame;
    diag.once('frame', (value) => { frame = value; });
    callbacks.sendTasuResponse({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, 0x12, 0, 0, 0x62, 0xf1, 0x95]) });
    assert.deepStrictEqual(frame, { ecu: 0x12, uds: [0x62, 0xf1, 0x95] });
    await Promise.all([signals.call(native, 'one', { test: 1 }, 123), signals.call(native, 'two', { test: 2 }, 456)]);
    assert.strictEqual(maxActive, 1, 'native method calls are serialized');
    assert.deepStrictEqual(events.map((event) => [event.method, event.timeout]), [['one', 123], ['two', 456]]);
    builders.buildTypedProxy = async () => { throw new Error('missing donor definition'); };
    const before = events.length;
    await assert.rejects(() => signals.proxy('unused', '1'), /missing donor definition/);
    assert.strictEqual(events.length, before, 'failed proxy creation emits no method and is not retried');
    console.log('SDK diagnostic adapter verified: donor builder/init, availability and response propagation, no startup diagnostic calls, serialized method calls, failure without retry.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
