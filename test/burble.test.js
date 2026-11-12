'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { Bm3Controller } = require('../src/controller');
const bundled = require('../vendor/bm3-map-profiles.json');

function fixture(options) {
    const opts = options || {};
    const profile = opts.realProfile ? JSON.parse(JSON.stringify(bundled.F4C9L8R02)) : {
        rom: 'TEST_ROM', mapSwActAddr: '60000000', burbleActAddr: '60000099', wmbaCmd: opts.sid || '3e',
        liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: '60000100', factor: 2 } },
    };
    if (opts.mutate) opts.mutate(profile);
    const state = { slot: 0, enabled: 1, timing: Array(24).fill(0xFD), marker: 'BM3_R#' + profile.rom + '#', active: 0, maxActive: 0, override: null };
    const calls = [], diag = new EventEmitter();
    diag.available = true;
    diag.setAvailable = (available) => { diag.available = available; diag.emit('available', available); };
    diag.physical = async function (target, sid, data, timeout, accepts, requestOpts) {
        assert.strictEqual(target, 0x12);
        assert.strictEqual(timeout, 4500);
        assert.deepStrictEqual(requestOpts, { maxRetries: 0, callTimeoutMs: 4500, pendingTimeoutMs: 4500, hardTimeoutMs: 9000 });
        const call = { sid, data: data.slice() };
        calls.push(call);
        state.maxActive = Math.max(state.maxActive, ++state.active);
        try {
            await new Promise(setImmediate);
            if (state.override) {
                const changed = await state.override(call);
                if (changed !== undefined) return changed;
            }
            let response;
            const address = Buffer.from(data.slice(1, 5)).toString('hex').toUpperCase();
            const table = profile.liveTuneTables.KF_DZWMIN_SPORT_SOT;
            if (sid === 0x2C) response = [0x6C, 2, 0xF3, 1];
            else if (sid === 0x22) response = [0x62, 0xF3, 1].concat(Array.from(Buffer.from(state.marker)));
            else if (sid === 0x23) {
                assert.strictEqual(data[0], 0x14);
                if (address === profile.mapSwActAddr) { assert.strictEqual(data[5], 1); response = [0x63, state.slot]; }
                else if (address === profile.burbleActAddr) { assert.strictEqual(data[5], 1); response = [0x63, state.enabled]; }
                else if (address === table.address) { assert.strictEqual(data[5], 24); response = [0x63].concat(state.timing); }
                else throw new Error('Unexpected read address');
            } else if (sid === parseInt(profile.wmbaCmd, 16)) {
                assert.strictEqual(data[0], 0x14);
                assert.strictEqual(data[5], data.length - 6);
                if (address === profile.burbleActAddr) { assert.strictEqual(data[5], 1); state.enabled = data[6]; }
                else if (address === table.address) { assert.strictEqual(data[5], 24); state.timing = data.slice(6); }
                else if (address === profile.mapSwActAddr) { assert.strictEqual(data[5], 2); state.slot = data[6]; }
                else throw new Error('Unexpected write address');
                response = sid === 0x3D ? [0x7D] : [0x7E, 0x3D];
            } else throw new Error('Unexpected diagnostic service');
            assert(accepts(response));
            return response;
        } finally { state.active--; }
    };
    const controller = new Bm3Controller(diag, { identityMode: 'legacy-did', markerAddress: opts.noMarker ? null : '60000200' }, { [profile.rom]: profile });
    return { controller, diag, calls, state, profile,
        writes: () => calls.filter((call) => call.sid === parseInt(profile.wmbaCmd, 16)),
        prepare: async () => { await controller.identify(); return controller.refreshBurble(); } };
}
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('no startup traffic and missing marker blocks all burble operations', async () => {
    const f = fixture({ noMarker: true });
    assert.strictEqual(f.calls.length, 0);
    await assert.rejects(() => f.controller.identify(), /verified 32-bit/);
    await assert.rejects(() => f.controller.refreshBurble(), /Identify/);
    await assert.rejects(() => f.controller.setBurble(2), /Read burbles/);
    await assert.rejects(() => f.controller.disableBurble(), /Read burbles/);
    assert.strictEqual(f.calls.length, 0);
});
test('explicit current read is required before either apply or Off', async () => {
    for (const action of [(c) => c.setBurble(1), (c) => c.disableBurble()]) {
        const f = fixture(); await f.controller.identify(); const count = f.calls.length;
        await assert.rejects(() => action(f.controller), /Read burbles/);
        assert.strictEqual(f.calls.length, count);
        assert.strictEqual(f.controller.snapshot().ready, false);
    }
});
test('readback distinguishes enabled aggression, custom table, and Off', async () => {
    const f = fixture();
    let s = await f.prepare();
    assert.strictEqual(s.burbleReady, true); assert.strictEqual(s.burbleEnabled, true); assert.strictEqual(s.burbleAggression, 1.5); assert.strictEqual(s.burbleCustom, false);
    f.state.timing[3] = 0xFC;
    s = await f.controller.refreshBurble();
    assert.strictEqual(s.burbleAggression, null); assert.strictEqual(s.burbleCustom, true);
    f.state.enabled = 0;
    s = await f.controller.refreshBurble();
    assert.strictEqual(s.burbleEnabled, false); assert.strictEqual(s.burbleAggression, null); assert.strictEqual(s.burbleCustom, false);
});
for (const sid of ['3d', '3e']) test('all 25 half-step values and Off use exact writes/readback via ' + sid, async () => {
    const f = fixture({ sid }); await f.prepare();
    for (let value = 0; value <= 12; value += .5) {
        const before = f.writes().length;
        const result = await f.controller.setBurble(value);
        assert.strictEqual(result.burbleAggression, value);
        assert.strictEqual(result.burbleEnabled, true);
        assert.strictEqual(f.writes().length - before, 2);
        assert.deepStrictEqual(f.state.timing, Array(24).fill(Math.trunc(-value * 2) & 255));
        assert.strictEqual(f.state.enabled, 1);
    }
    const off = await f.controller.disableBurble();
    assert.strictEqual(off.burbleEnabled, false); assert.strictEqual(off.burbleAggression, null);
    assert.deepStrictEqual(f.state.timing, Array(24).fill(0));
    assert.strictEqual(f.state.maxActive, 1);
});
test('real F4C9L8R02 metadata selects exact upstream addresses and 3E command', async () => {
    const f = fixture({ realProfile: true }); await f.prepare(); await f.controller.setBurble(4.5);
    assert.deepStrictEqual(f.writes().map((call) => call.data.slice(0, 6)), [[0x14, 0x60, 3, 0x80, 0x99, 1], [0x14, 0x60, 3, 0x81, 0, 24]]);
    assert(f.writes().every((call) => call.sid === 0x3E));
    assert.strictEqual(f.controller.snapshot().rom, 'F4C9L8R02');
});
for (const value of [-.5, 12.5, .25, NaN, Infinity, null, undefined, true, '2']) test('reject invalid aggression ' + String(value), async () => {
    const f = fixture(); await f.prepare(); const count = f.calls.length;
    await assert.rejects(() => f.controller.setBurble(value), /0 to 12/);
    assert.strictEqual(f.calls.length, count); assert.strictEqual(f.writes().length, 0);
    assert.strictEqual(f.controller.snapshot().burbleReady, false);
});
test('fresh current read prevents unnecessary writes despite stale UI', async () => {
    const f = fixture(); await f.prepare(); f.state.timing = Array(24).fill(0xF8);
    await f.controller.setBurble(4);
    assert.strictEqual(f.writes().length, 0);
    f.state.enabled = 0; f.state.timing = Array(24).fill(0);
    await f.controller.disableBurble();
    assert.strictEqual(f.writes().length, 0);
});
test('Off still zeros table when flag is already disabled', async () => {
    const f = fixture(); await f.prepare(); f.state.enabled = 0;
    await f.controller.disableBurble();
    assert.strictEqual(f.writes().length, 2); assert.deepStrictEqual(f.state.timing, Array(24).fill(0));
});
test('nonuniform and out-of-range tables are custom, never a guessed preset', async () => {
    for (const timing of [Array(24).fill(1), Array(24).fill(0x80), Array.from({length: 24}, (_, i) => i)]) {
        const f = fixture(); f.state.timing = timing;
        assert.strictEqual((await f.prepare()).burbleCustom, true);
        assert.strictEqual(f.controller.snapshot().burbleAggression, null);
    }
});
test('profile metadata is deeply copied and not editable through original object', async () => {
    const f = fixture();
    f.profile.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor = 0;
    f.profile.liveTuneTables.KF_DZWMIN_SPORT_SOT.address = 'DEADBEEF';
    // Fixture memory routing uses this profile; restore routing after proving the
    // controller's frozen nested table differs from the caller's mutable object.
    assert.strictEqual(f.controller._profiles.TEST_ROM.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor, 2);
    assert.strictEqual(f.controller._profiles.TEST_ROM.liveTuneTables.KF_DZWMIN_SPORT_SOT.address, '60000100');
});
test('invalid widths, address overlaps/overflow and factors block before burble reads', async () => {
    const changes = [p => { p.burbleActAddr = '1234'; }, p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.address = '0x60000100'; },
        p => { p.burbleActAddr = p.mapSwActAddr; }, p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.address = 'FFFFFFF0'; },
        p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor = 1; }, p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor = 12; },
        p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor = -2; }, p => { p.liveTuneTables.KF_DZWMIN_SPORT_SOT.factor = '2'; }];
    for (const mutate of changes) {
        const f = fixture({ mutate }); await f.controller.identify(); const count = f.calls.filter(c => c.sid === 0x23).length;
        await assert.rejects(() => f.controller.refreshBurble(), /address|factor/);
        assert.strictEqual(f.calls.filter(c => c.sid === 0x23).length, count);
        assert.strictEqual(f.writes().length, 0);
    }
});
test('wrong or changed ROM blocks every burble write', async () => {
    const f = fixture(); await f.prepare(); f.state.marker = 'BM3_R#F4C9L8R02evil';
    await assert.rejects(() => f.controller.setBurble(3), /marker/);
    assert.strictEqual(f.writes().length, 0); assert.strictEqual(f.controller.snapshot().ready, false);
});
test('invalid current enable/table bytes or length invalidate all readiness', async () => {
    for (const change of [s => { s.enabled = 2; }, s => { s.timing = [0]; }, s => { s.timing[2] = 256; }]) {
        const f = fixture(); await f.controller.identify(); change(f.state);
        await assert.rejects(() => f.controller.refreshBurble(), /Invalid|Malformed/);
        assert.strictEqual(f.controller.snapshot().burbleReady, false); assert.strictEqual(f.controller.snapshot().ready, false);
    }
});
test('no response/echo to first write prevents second write and latches unknown', async () => {
    for (const response of [null, [0x7E, 0x00], [0x7F, 0x3E, 0x33]]) {
        const f = fixture(); await f.prepare(); f.state.override = async call => call.sid === 0x3E ? response : undefined;
        await assert.rejects(() => f.controller.setBurble(3), /Burble outcome unknown/);
        assert.strictEqual(f.writes().length, 1); assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
        await assert.rejects(() => f.controller.disableBurble(), /Read burbles/);
        assert.strictEqual(f.writes().length, 1); assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
    }
});
test('second write timeout leaves partial change unknown and is never retried', async () => {
    const f = fixture(); await f.prepare();
    f.state.override = async call => { if (call.sid === 0x3E && call.data[5] === 24) throw new Error('timeout'); };
    await assert.rejects(() => f.controller.disableBurble(), /Burble outcome unknown/);
    assert.strictEqual(f.writes().length, 2); assert.strictEqual(f.state.enabled, 0);
    assert.strictEqual(f.controller.snapshot().transportResetRequired, true);
});
test('successful acknowledgments with mismatching readback are unknown', async () => {
    const f = fixture(); await f.prepare(); f.state.override = async call => call.sid === 0x3E ? [0x7E, 0x3D] : undefined;
    await assert.rejects(() => f.controller.setBurble(3), /Burble outcome unknown.*readback differs/);
    assert.strictEqual(f.writes().length, 2); assert.strictEqual(f.controller.snapshot().burbleAggression, null);
});
test('apply, map and refresh share one whole-operation lock and never queue', async () => {
    const f = fixture(); await f.prepare(); const first = f.controller.setBurble(2);
    await assert.rejects(() => f.controller.setBurble(3), /no action was queued/);
    await assert.rejects(() => f.controller.disableBurble(), /no action was queued/);
    await assert.rejects(() => f.controller.select(2), /no action was queued/);
    await assert.rejects(() => f.controller.refreshBurble(), /no action was queued/);
    assert.strictEqual((await first).burbleAggression, 2);
    assert.strictEqual(f.writes().length, 2); assert.strictEqual(f.state.maxActive, 1);
});
test('promise does not resolve until both writes and both readbacks finish', async () => {
    const f = fixture(); await f.prepare(); let release;
    const pending = new Promise(resolve => { release = resolve; });
    f.state.override = async call => { if (call.sid === 0x23 && call.data[5] === 24 && f.writes().length === 2) await pending; };
    let complete = false; const operation = f.controller.setBurble(2).then(result => { complete = true; return result; });
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.strictEqual(f.writes().length, 2); assert.strictEqual(complete, false); assert.strictEqual(f.controller.snapshot().busy, true);
    release(); assert.strictEqual((await operation).burbleAggression, 2);
});
test('disconnect before write blocks and disconnect during write is unknown', async () => {
    for (const duringWrite of [false, true]) {
        const f = fixture(); await f.prepare();
        f.state.override = async call => {
            if ((duringWrite && call.sid === 0x3E) || (!duringWrite && call.sid === 0x22)) {
                f.diag.setAvailable(false); f.diag.setAvailable(true);
            }
        };
        await assert.rejects(() => f.controller.setBurble(2), duringWrite ? /outcome unknown/ : /changed during/);
        assert.strictEqual(f.writes().length, duringWrite ? 1 : 0);
        assert.strictEqual(f.controller.snapshot().outcomeUnknown, duringWrite);
    }
});
test('map refresh/switch and reidentify require a fresh burble read', async () => {
    for (const action of [c => c.refresh(), c => c.select(2), c => c.identify()]) {
        const f = fixture(); await f.prepare(); await action(f.controller);
        assert.strictEqual(f.controller.snapshot().ready, true); assert.strictEqual(f.controller.snapshot().burbleReady, false);
        await assert.rejects(() => f.controller.setBurble(2), /Read burbles/);
    }
});
test('external bridge session clears burble cache and reidentify still needs a separate read', async () => {
    const f = fixture(); await f.prepare();
    assert.strictEqual(f.controller.snapshot().burbleReady, true);
    const count = f.calls.length;
    f.controller.invalidateForExternalSession();
    assert.strictEqual(f.calls.length, count);
    assert.strictEqual(f.controller.snapshot().burbleReady, false);
    assert.strictEqual(f.controller.snapshot().burbleAggression, null);
    await f.controller.identify();
    await assert.rejects(() => f.controller.setBurble(2), /Read burbles/);
    assert.strictEqual(f.writes().length, 0);
});

(async () => {
    for (const item of tests) { await item.fn(); console.log('ok - ' + item.name); }
    console.log(tests.length + ' synthetic burble checks passed; no vehicle contacted.');
})().catch(error => { console.error(error); process.exitCode = 1; });
