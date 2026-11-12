'use strict';
const assert = require('assert');
const EventEmitter = require('events');
const { Bm3Controller } = require('../src/controller');

function fixture(options) {
    const opts = options || {}, calls = [], profile = { rom: 'TEST_ROM', mapSwActAddr: '60000000', wmbaCmd: opts.sid || '3d' };
    const state = { slot: 0, marker: 'BM3_R#TEST_ROM#', active: 0, maxActive: 0, override: null };
    const diag = new EventEmitter();
    diag.available = true;
    diag.setAvailable = (available) => { diag.available = available; diag.emit('available', available); };
    diag.physical = async function (target, sid, data, timeout, accepts, requestOpts) {
        assert.strictEqual(target, 0x12);
        assert.strictEqual(timeout, 4500);
        assert.deepStrictEqual(requestOpts, { maxRetries: 0, callTimeoutMs: 4500, pendingTimeoutMs: 4500, hardTimeoutMs: 9000 });
        calls.push({ target, sid, data: data.slice(), requestOpts });
        state.maxActive = Math.max(state.maxActive, ++state.active);
        await new Promise(setImmediate);
        state.active--;
        if (state.override) {
            const result = await state.override(sid, data, accepts);
            if (result !== undefined) return result;
        }
        let response;
        if (sid === 0x2C) response = [0x6C, 2, 0xF3, 1];
        else if (sid === 0x22) response = [0x62, 0xF3, 1].concat(Array.from(Buffer.from(state.marker)));
        else if (sid === 0x23) response = [0x63, state.slot];
        else if ([0x3D, 0x3E].includes(sid)) {
            assert.deepStrictEqual(data.slice(0, 6), [0x14, 0x60, 0, 0, 0, 2]);
            assert(data[6] >= 0 && data[6] <= 3);
            assert.strictEqual(data[7], 1);
            state.slot = data[6];
            response = sid === 0x3D ? [0x7D] : [0x7E, 0x3D];
        } else throw new Error('Forbidden diagnostic service');
        assert(accepts(response));
        return response;
    };
    const ctl = new Bm3Controller(diag, { identityMode: 'legacy-did', markerAddress: opts.noAddress ? null : '60000100' }, { TEST_ROM: profile });
    return { ctl, diag, calls, state, profile, writes: () => calls.filter((c) => [0x3D, 0x3E].includes(c.sid)) };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('startup emits no diagnostic traffic; frozen externally read-only configuration', async () => {
    const f = fixture();
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.throws(() => { f.ctl.config.markerAddress = 'DEADBEEF'; }, TypeError);
    assert.throws(() => { f.ctl.config = {}; }, TypeError);
    f.profile.mapSwActAddr = 'DEADBEEF';
    await f.ctl.identify();
    await f.ctl.select(2); // profile copy retained original address
});
test('missing marker address blocks before any traffic', async () => {
    const f = fixture({ noAddress: true });
    await assert.rejects(() => f.ctl.identify(), /verified 32-bit/);
    assert.strictEqual(f.calls.length, 0);
});
test('cannot switch or refresh without an explicit successful identification', async () => {
    const f = fixture();
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    await assert.rejects(() => f.ctl.refresh(), /Identify/);
    assert.strictEqual(f.calls.length, 0);
});
for (const sid of ['3d', '3e']) test('map-only switch and readback using ' + sid, async () => {
    const f = fixture({ sid });
    const initial = await f.ctl.identify();
    assert.strictEqual(initial.currentMap, 1);
    assert.strictEqual(initial.rom, 'TEST_ROM');
    assert(initial.ready);
    for (const slot of [2, 3, 4, 1]) assert.strictEqual((await f.ctl.select(slot)).currentMap, slot);
    assert.strictEqual(f.writes().length, 4);
    assert(f.calls.every((c) => [0x2C, 0x22, 0x23, parseInt(sid, 16)].includes(c.sid)));
    assert.strictEqual(f.state.maxActive, 1);
});
test('current-map selection does not write', async () => {
    const f = fixture(); await f.ctl.identify(); await f.ctl.select(1);
    assert.strictEqual(f.writes().length, 0);
});
for (const slot of [-1, 0, 5, 1.5, NaN, '2']) test('reject invalid map slot ' + String(slot), async () => {
    const f = fixture(); await f.ctl.identify();
    const count = f.calls.length;
    await assert.rejects(() => f.ctl.select(slot), /slot must/);
    assert.strictEqual(f.calls.length, count);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
for (const marker of ['TEST_ROM', 'XBM3_R#TEST_ROM', 'BM3_Rsuffix#TEST_ROM', 'BM3_R#UNKNOWN', 'BM3_R#TEST_ROM_EXTRA', 'BM3_R#TEST_ROM10', 'BM3_R#TEST_ROM-other', 'BM3_R#TEST_ROM.other', 'BM3_R#TEST_ROM#UNKNOWN', 'BM3_R#TEST_ROM#TEST_ROM']) {
    test('unknown/ambiguous/spoofed marker blocked: ' + marker, async () => {
        const f = fixture(); f.state.marker = marker;
        await assert.rejects(() => f.ctl.identify(), /marker/);
        assert.strictEqual(f.ctl.snapshot().ready, false);
        assert.strictEqual(f.writes().length, 0);
    });
}
test('malformed current map cannot enable controls', async () => {
    const f = fixture(); f.state.slot = 4;
    await assert.rejects(() => f.ctl.identify(), /Invalid current-map/);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
test('malformed response bytes and positive SID blocked', async () => {
    for (const reply of [[0x6C, 2, 0xF3, 1, 999], [0x62, 2, 0xF3, 1], null]) {
        const f = fixture(); f.state.override = async () => reply;
        await assert.rejects(() => f.ctl.identify(), /Malformed|Unexpected/);
        assert.strictEqual(f.ctl.snapshot().ready, false);
    }
});
test('negative response has no automatic retry', async () => {
    const f = fixture(); f.state.override = async (sid) => [0x7F, sid, 0x33];
    await assert.rejects(() => f.ctl.identify(), /NRC 33/);
    assert.strictEqual(f.calls.length, 1);
});
test('marker is revalidated before every write; identity change blocks', async () => {
    const f = fixture(); await f.ctl.identify(); f.state.marker = 'BM3_R#DIFFERENT';
    await assert.rejects(() => f.ctl.select(2), /unknown/);
    assert.strictEqual(f.writes().length, 0);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
test('transport disconnect invalidates ready state before write', async () => {
    const f = fixture(); await f.ctl.identify(); f.diag.available = false;
    await assert.rejects(() => f.ctl.select(2), /unavailable/);
    assert.strictEqual(f.writes().length, 0);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
test('availability event immediately invalidates readiness even without a user action', async () => {
    const f = fixture(); await f.ctl.identify(); f.diag.setAvailable(false);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().currentMap, null);
    assert.strictEqual(f.ctl.snapshot().transportResetRequired, true);
    f.diag.setAvailable(true);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().transportResetRequired, false);
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    assert.strictEqual(f.writes().length, 0);
    assert.strictEqual((await f.ctl.identify()).ready, true);
});
test('transient disconnect/reconnect during an operation prevents subsequent write', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => {
        if (sid === 0x23) { f.diag.setAvailable(false); f.diag.setAvailable(true); return [0x63, 0]; }
    };
    await assert.rejects(() => f.ctl.select(2), /changed during/);
    assert.strictEqual(f.writes().length, 0);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
test('late disconnect after final map read cannot restore readiness or clear unknown outcome', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => { if (sid === 0x3D) return [0x7D]; };
    await assert.rejects(() => f.ctl.select(2), /Switch outcome unknown/);
    f.state.override = null;
    const originalCurrent = f.ctl._current.bind(f.ctl);
    f.ctl._current = async (profile) => {
        const result = await originalCurrent(profile);
        f.diag.setAvailable(false); f.diag.setAvailable(true);
        return result;
    };
    await assert.rejects(() => f.ctl.identify(), /changed during/);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
});
test('disconnect during a write latches outcome unknown even if transport returns success', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => {
        if (sid === 0x3D) { f.diag.setAvailable(false); f.diag.setAvailable(true); return [0x7D]; }
    };
    await assert.rejects(() => f.ctl.select(2), /Switch outcome unknown/);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});
test('double click is rejected without queued writes or overlapping transactions', async () => {
    const f = fixture(); await f.ctl.identify();
    const first = f.ctl.select(2);
    await assert.rejects(() => f.ctl.select(3), /no action was queued/);
    await assert.rejects(() => f.ctl.refresh(), /no action was queued/);
    assert.strictEqual((await first).currentMap, 2);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.state.maxActive, 1);
});
test('timeout during identification blocks readiness and is never retried', async () => {
    const f = fixture(); f.state.override = async () => { throw new Error('timeout'); };
    await assert.rejects(() => f.ctl.identify(), /timeout/);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().transportResetRequired, true);
    f.state.override = null;
    await assert.rejects(() => f.ctl.identify(), /reconnect/);
    assert.strictEqual(f.calls.length, 1);
    f.diag.setAvailable(false); f.diag.setAvailable(true);
    assert.strictEqual((await f.ctl.identify()).ready, true);
});
test('lost write acknowledgment is outcome unknown with no retry', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => { if (sid === 0x3D) throw new Error('timeout'); };
    await assert.rejects(() => f.ctl.select(2), /Switch outcome unknown/);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.ctl.refresh(), /Identify/);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.ctl.identify(), /reconnect/);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    f.diag.setAvailable(false); f.diag.setAvailable(true);
    f.state.override = null; f.state.marker = 'BM3_R#UNKNOWN';
    await assert.rejects(() => f.ctl.identify(), /unknown/);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    f.state.marker = 'BM3_R#TEST_ROM#';
    const recovered = await f.ctl.identify();
    assert.strictEqual(recovered.ready, true);
    assert.strictEqual(recovered.outcomeUnknown, false);
});
test('readback mismatch is outcome unknown and clears displayed state', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => { if (sid === 0x3D) return [0x7D]; };
    await assert.rejects(() => f.ctl.select(2), /Switch outcome unknown.*readback differs/);
    const s = f.ctl.snapshot();
    assert.strictEqual(s.ready, false); assert.strictEqual(s.currentMap, null); assert(s.outcomeUnknown);
    assert.strictEqual(f.writes().length, 1);
});
test('current map is freshly read so external switching never causes stale UI', async () => {
    const f = fixture(); await f.ctl.identify(); f.state.slot = 3;
    assert.strictEqual((await f.ctl.refresh()).currentMap, 4);
    f.state.slot = 1;
    await f.ctl.select(2);
    assert.strictEqual(f.writes().length, 0);
});
test('external session invalidates cached map without traffic and requires fresh Identify', async () => {
    const f = fixture(); await f.ctl.identify();
    const count = f.calls.length;
    f.ctl.invalidateForExternalSession();
    assert.strictEqual(f.calls.length, count);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().currentMap, null);
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    assert.strictEqual(f.calls.length, count);
    f.state.slot = 2;
    assert.strictEqual((await f.ctl.identify()).currentMap, 3);
});
test('external session aborts an in-flight read/write without restoring readiness', async () => {
    for (const write of [false, true]) {
        const f = fixture(); await f.ctl.identify();
        f.state.override = async (sid) => {
            if (sid === (write ? 0x3D : 0x23)) {
                f.ctl.invalidateForExternalSession();
                return write ? [0x7D] : [0x63, 0];
            }
        };
        await assert.rejects(() => f.ctl.select(2), write ? /outcome unknown/ : /changed during/);
        assert.strictEqual(f.writes().length, write ? 1 : 0);
        assert.strictEqual(f.ctl.snapshot().ready, false);
        assert.strictEqual(f.ctl.snapshot().outcomeUnknown, write);
        assert.strictEqual(f.ctl.snapshot().transportResetRequired, true);
        f.ctl.invalidateForExternalSession();
        assert.strictEqual(f.ctl.snapshot().outcomeUnknown, write, 'later invalidation cannot clear uncertain outcome');
    }
});

(async () => {
    for (const t of tests) { await t.fn(); console.log('ok - ' + t.name); }
    console.log(tests.length + ' synthetic controller checks passed; no vehicle contacted.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
