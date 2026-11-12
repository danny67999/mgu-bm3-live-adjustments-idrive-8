'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { VALVE_ADAPTER_ID, EXPERIMENTAL_VALVE_ADAPTER_ID,
    validateValveMode, validateValveAdapter, validateValveConfiguration, applyValve } = require('../src/valves');
const { Bm3Controller } = require('../src/controller');
const metadata = require('../vendor/bm3-valve-protocol.json');

const gate = Object.freeze({ id: VALVE_ADAPTER_ID, rom: 'TEST_ROM', softwareIdentityHex: '01020304' });
const identity = Object.freeze({ rom: 'TEST_ROM' });
const expected = { open: [0x60, 0xFD, 3, 0x14, 0xFE], closed: [0x60, 0xFD, 3, 0x23, 0x28], auto: [0x60, 0xFD, 0] };
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fixture() {
    const calls = [];
    let override = null;
    const request = async (sid, data, prefix) => {
        calls.push({ sid, data: data.slice(), prefix: prefix.slice() });
        await new Promise(setImmediate);
        if (override) return override(sid, data, prefix);
        if (sid === 0x22) return [0x62, 0xF1, 0x95, 1, 2, 3, 4];
        if (sid === 0x2F) return [0x6F].concat(data.slice(0, 3));
        throw new Error('Unexpected service');
    };
    return { request, calls, override(fn) { override = fn; } };
}

test('module and gate validation send nothing and retain immutable verification', async () => {
    const f = fixture();
    const verified = validateValveAdapter(gate, identity);
    assert(Object.isFrozen(verified));
    assert.deepStrictEqual(verified, gate);
    assert.deepStrictEqual(f.calls, []);
    assert.strictEqual(metadata.defaultEnabled, false);
    assert.deepStrictEqual(metadata.verifiedProductionVehicles, []);
});

for (const mode of ['open', 'closed', 'auto']) test('fixed ' + mode + ' command uses exact identity and acknowledgment is not position', async () => {
    const f = fixture();
    const result = await applyValve(f.request, mode, gate, identity);
    assert.strictEqual(result.requested, mode);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.confirmed, 'unknown');
    assert.deepStrictEqual(f.calls, [
        { sid: 0x22, data: [0xF1, 0x95], prefix: [0xF1, 0x95] },
        { sid: 0x2F, data: expected[mode], prefix: expected[mode].slice(0, 3) },
    ]);
    assert.strictEqual(Buffer.from([0x2F].concat(expected[mode])).toString('hex').toUpperCase(), metadata.requests[mode]);
    if (mode === 'auto') assert.match(result.detail, /return to automatic control/);
});

test('invalid modes, missing gate, unknown adapters and exact ROM mismatch emit no requests', async () => {
    const f = fixture();
    for (const mode of [undefined, null, '', 'OEM', 'OPEN', 'close', 0, {}, ['open']]) {
        assert.throws(() => validateValveMode(mode), /mode/);
        await assert.rejects(() => applyValve(f.request, mode, gate, identity), /mode/);
    }
    for (const verification of [null, {}, Object.assign({}, gate, { id: 'mg1-el-agk' }),
        Object.assign({}, gate, { id: 'mhd-flap' }), Object.assign({}, gate, { rom: 'TEST_ROM_MORE' }),
        Object.assign({}, gate, { softwareIdentityHex: '' }), Object.assign({}, gate, { softwareIdentityHex: 'ABC' }),
        Object.assign({}, gate, { softwareIdentityHex: 'GG' }), Object.assign({}, gate, { did: '60FD' })]) {
        await assert.rejects(() => applyValve(f.request, 'open', verification, identity), /adapter|identity|ROM/);
    }
    await assert.rejects(() => applyValve(f.request, 'open', gate, null), /Identify/);
    assert.deepStrictEqual(f.calls, []);
});

test('software identity mismatch blocks before actuation', async () => {
    const f = fixture();
    f.override(() => [0x62, 0xF1, 0x95, 1, 2, 3, 5]);
    await assert.rejects(() => applyValve(f.request, 'open', gate, identity), /software identity does not match/);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].sid, 0x22);
});

test('malformed software replies never cause valve actuation', async () => {
    for (const reply of [null, [], [0x62, 0xF1, 0x95], [0x62, 0xF1, 0x94, 1, 2, 3, 4],
        [0x62, 0xF1, 0x95, 1, 2, 3, 4, 256], [0x7F, 0x22, 0x31]]) {
        const f = fixture(); f.override(() => reply);
        await assert.rejects(() => applyValve(f.request, 'open', gate, identity));
        assert.strictEqual(f.calls.length, 1);
    }
});

test('no response, NRC and mismatched valve echo are errors with no retry or auto-release', async () => {
    for (const reply of [null, [], [0x7F, 0x2F, 0x31], [0x6F, 0x60, 0xFD, 0],
        [0x6F, 0x02, 1], [0x6F, 0x60, 0xFE, 3], [0x6F, 0x60, 0xFD, 3, 999]]) {
        const f = fixture();
        f.override((sid) => sid === 0x22 ? [0x62, 0xF1, 0x95, 1, 2, 3, 4] : reply);
        await assert.rejects(() => applyValve(f.request, 'open', gate, identity));
        assert.strictEqual(f.calls.length, 2);
        assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 1);
    }
    const f = fixture();
    f.override((sid) => { if (sid === 0x2F) throw new Error('timeout'); return [0x62, 0xF1, 0x95, 1, 2, 3, 4]; });
    await assert.rejects(() => applyValve(f.request, 'closed', gate, identity), /timeout/);
    assert.strictEqual(f.calls.length, 2);
});

function controllerFixture(verification) {
    const calls = [], diag = new EventEmitter();
    const state = { active: 0, maximum: 0, override: null };
    diag.available = true;
    diag.physical = async (target, sid, data, timeout, matches, opts) => {
        assert.strictEqual(target, 0x12);
        assert.strictEqual(opts.maxRetries, 0);
        calls.push({ sid, data: data.slice() });
        state.maximum = Math.max(state.maximum, ++state.active);
        await new Promise(setImmediate);
        state.active--;
        if (state.override) {
            const response = await state.override(sid, data);
            if (response !== undefined) return response;
        }
        if (sid === 0x2C) return [0x6C, 2, 0xF3, 1];
        if (sid === 0x22 && data[0] === 0xF3) return [0x62, 0xF3, 1].concat(Array.from(Buffer.from('BM3_R#TEST_ROM#')));
        if (sid === 0x22 && data[0] === 0xF1) return [0x62, 0xF1, 0x95, 1, 2, 3, 4];
        if (sid === 0x23) return [0x63, 0];
        if (sid === 0x2F) return [0x6F].concat(data.slice(0, 3));
        throw new Error('Unexpected fixture service');
    };
    const controller = new Bm3Controller(diag, { identityMode: 'legacy-did', markerAddress: '60000100', verifiedValveAdapter: verification },
        { TEST_ROM: { rom: 'TEST_ROM', mapSwActAddr: '60000000', wmbaCmd: '3d' } });
    return { controller, diag, calls, state };
}

test('shared controller rejects simultaneous map and valve actions without queueing', async () => {
    const f = controllerFixture(gate);
    assert.deepStrictEqual(f.calls, []);
    await f.controller.identify();
    const opening = f.controller.setValve('open');
    await assert.rejects(() => f.controller.setValve('auto'), /progress|queued/);
    await assert.rejects(() => f.controller.select(2), /progress|queued/);
    const result = await opening;
    assert.strictEqual(result.valveAcceptedMode, 'open');
    assert.strictEqual(result.valvePosition, 'unknown');
    assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 1);
    assert.strictEqual(f.state.maximum, 1);
});

test('an unconfigured valve gate blocks before any additional diagnostic request', async () => {
    const f = controllerFixture(null);
    assert.strictEqual(f.controller.snapshot().valveConfigured, false);
    await f.controller.identify();
    const before = f.calls.length;
    await assert.rejects(() => f.controller.setValve('auto'), /verified|verification|adapter/i);
    assert.strictEqual(f.calls.length, before);
});

test('fresh software mismatch never reaches actuation or claims an uncertain write', async () => {
    const f = controllerFixture(gate);
    await f.controller.identify();
    f.state.override = async (sid, data) => {
        if (sid === 0x22 && data[0] === 0xF1) return [0x62, 0xF1, 0x95, 0xFF];
    };
    await assert.rejects(() => f.controller.setValve('open'), /software identity/);
    assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 0);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, false);
    assert.strictEqual(f.controller.snapshot().valveAcceptedMode, null);
});

test('transport epoch change during valve acceptance cannot restore a claimed result', async () => {
    const f = controllerFixture(gate);
    await f.controller.identify();
    f.state.override = async (sid, data) => {
        if (sid === 0x2F) {
            f.diag.available = false; f.diag.emit('available', false);
            f.diag.available = true; f.diag.emit('available', true);
            return [0x6F].concat(data.slice(0, 3));
        }
    };
    await assert.rejects(() => f.controller.setValve('open'), /changed|unknown/i);
    const result = f.controller.snapshot();
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.outcomeUnknown, true);
    assert.strictEqual(result.valveAcceptedMode, null);
    assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 1);
});

test('lost valve acknowledgment invalidates readiness and latches uncertain outcome', async () => {
    const f = controllerFixture(gate);
    await f.controller.identify();
    f.state.override = async (sid) => { if (sid === 0x2F) throw new Error('timeout'); };
    await assert.rejects(() => f.controller.setValve('closed'), /unknown|timeout/i);
    const result = f.controller.snapshot();
    assert.strictEqual(result.ready, false);
    assert.strictEqual(result.outcomeUnknown, true);
    assert.strictEqual(result.valvePosition, 'unknown');
    assert.strictEqual(result.valveAcceptedMode, null);
    await assert.rejects(() => f.controller.setValve('auto'));
    assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 1);
});

test('a definitive valve NRC reports rejection without claiming an unknown outcome or retrying', async () => {
    const f = controllerFixture(gate); await f.controller.identify();
    f.state.override = async (sid) => sid === 0x2F ? [0x7F, 0x2F, 0x31] : undefined;
    await assert.rejects(() => f.controller.setValve('open'), /NRC 31.*out of range/);
    const state = f.controller.snapshot();
    assert.strictEqual(state.outcomeUnknown, false); assert.strictEqual(state.ready, false);
    assert.strictEqual(state.valveAcceptedMode, null);
    assert.strictEqual(f.calls.filter((call) => call.sid === 0x2F).length, 1);
});

const experimental = Object.freeze({ id: EXPERIMENTAL_VALVE_ADAPTER_ID, rom: 'F4C9L8R02' });
const experimentalFixtureConfig = { markerAddress: '807FFE50', identityMode: 'direct-memory', expectedRom: 'F4C9L8R02', verifiedValveAdapter: null, experimentalValveAdapter: experimental };

test('experimental configuration is explicit, pinned, mutually exclusive and never called verified', () => {
    const config = experimentalFixtureConfig;
    assert.strictEqual(require('../config/vehicle.json').experimentalValveAdapter, null, 'general distribution never enables this experimental adapter by default');
    assert.deepStrictEqual(validateValveConfiguration(config), { verifiedValveAdapter: null, experimentalValveAdapter: experimental });
    assert(Object.isFrozen(validateValveConfiguration(config).experimentalValveAdapter));
    for (const change of [
        { identityMode: 'legacy-did' }, { markerAddress: '60000100' }, { expectedRom: 'F4C9L8R03' },
        { verifiedValveAdapter: gate }, { verifiedValveAdapter: experimental, experimentalValveAdapter: null },
        { experimentalValveAdapter: gate }, { experimentalValveAdapter: Object.assign({}, experimental, { rom: 'TEST_ROM' }) },
        { experimentalValveAdapter: Object.assign({}, experimental, { softwareIdentityHex: '01020304' }) }
    ]) assert.throws(() => validateValveConfiguration(Object.assign({}, config, change)));
});

for (const mode of ['open', 'closed', 'auto']) test('experimental ' + mode + ' uses the exact community payload without F195 or fallback', async () => {
    const f = fixture();
    const result = await applyValve(f.request, mode, experimental, { rom: 'F4C9L8R02' });
    assert.deepStrictEqual(f.calls, [{ sid: 0x2F, data: expected[mode], prefix: expected[mode].slice(0, 3) }]);
    assert.strictEqual(result.accepted, true);
    assert.strictEqual(result.confirmed, 'unknown');
    for (const identity of [null, { rom: 'F4C9L8R03' }]) {
        await assert.rejects(() => applyValve(f.request, mode, experimental, identity));
        assert.strictEqual(f.calls.length, 1);
    }
});

test('explicit experimental fixture controller rereads identity before each action and rejects changed ROM without a write', async () => {
    const config = experimentalFixtureConfig, calls = [], diag = new EventEmitter();
    const marker = Buffer.alloc(255, 0xA5);
    marker.write('BM3_', 0, 'ascii'); marker.write('#F4C9L8R02GGGJM_G87_RWD_USA_KOR_ULEV246_', 101, 'ascii'); marker[141] = 0;
    diag.available = true;
    diag.physical = async (target, sid, data, timeout, accepts, options) => {
        assert.strictEqual(target, 0x12); assert.strictEqual(options.maxRetries, 0);
        calls.push({ sid, data: data.slice() }); await new Promise(setImmediate);
        if (sid === 0x23) return data[data.length - 1] === 255 ? [0x63].concat(Array.from(marker)) : [0x63, 0];
        if (sid === 0x2F) return [0x6F].concat(data.slice(0, 3));
        throw new Error('Unexpected diagnostic request');
    };
    const ctl = new Bm3Controller(diag, config);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(ctl.snapshot().valveExperimental, true);
    await assert.rejects(() => ctl.setValve('open'), /Identify/);
    assert.deepStrictEqual(calls, []);
    await ctl.identify();
    for (const mode of ['open', 'closed', 'auto']) {
        const start = calls.length, action = ctl.setValve(mode);
        await assert.rejects(() => ctl.select(2), /progress/);
        await assert.rejects(() => ctl.setValve(mode), /progress/);
        const result = await action;
        assert.strictEqual(result.valveAcceptedMode, mode); assert.strictEqual(result.valvePosition, 'unknown');
        assert.deepStrictEqual(calls.slice(start).map((c) => c.sid), [0x23, 0x2F]);
        assert.deepStrictEqual(calls[calls.length - 1].data, expected[mode]);
    }
    marker[102] = 0x58;
    const before = calls.filter((c) => c.sid === 0x2F).length;
    await assert.rejects(() => ctl.setValve('open'), /marker/);
    assert.strictEqual(calls.filter((c) => c.sid === 0x2F).length, before);
    assert.strictEqual(ctl.snapshot().ready, false);
});

(async () => {
    for (const entry of tests) { await entry.fn(); console.log('ok - ' + entry.name); }
    console.log(tests.length + ' synthetic valve checks passed; no vehicle contacted.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
