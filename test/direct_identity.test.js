'use strict';
// Synthetic metadata only. Never reads or embeds the vehicle's marker capture.
const assert = require('assert');
const EventEmitter = require('events');
const { Bm3Controller, directMarkerRom, validateIdentityConfig } = require('../src/controller');
const profiles = require('../vendor/bm3-map-profiles.json');
const ROM = 'F4C9L8R02';
const TAG = '#F4C9L8R02GGGJM_G87_RWD_USA_KOR_ULEV246_';
const CONFIG = Object.freeze({ markerAddress: '807FFE50', identityMode: 'direct-memory', expectedRom: ROM, verifiedValveAdapter: null });
const MARKER_READ = [0x14, 0x80, 0x7F, 0xFE, 0x50, 0xFF];
const MAP_READ = [0x14, 0x60, 0x03, 0x80, 0x06, 1];

function marker() {
    // Deterministic dummy bytes intentionally include nonzero opaque metadata.
    const data = Buffer.alloc(255, 0xA5);
    data.write('BM3_', 0, 'ascii');
    data.write(TAG, 101, 'ascii');
    data[141] = 0;
    return data;
}

function fixture() {
    const calls = [], state = { marker: marker(), slot: 0, override: null, active: 0, maxActive: 0 };
    const diag = new EventEmitter();
    diag.available = true;
    diag.setAvailable = (value) => { diag.available = value; diag.emit('available', value); };
    diag.physical = async (target, sid, data, timeout, accepts, options) => {
        assert.strictEqual(target, 0x12);
        assert.strictEqual(timeout, 4500);
        assert.deepStrictEqual(options, { maxRetries: 0, callTimeoutMs: 4500, pendingTimeoutMs: 4500, hardTimeoutMs: 9000 });
        assert([0x23, 0x3E].includes(sid), 'direct path must never define DIDs/change sessions/issue an unrelated control');
        calls.push({ sid, data: data.slice(), options });
        state.maxActive = Math.max(state.maxActive, ++state.active);
        await new Promise(setImmediate);
        try {
            if (state.override) {
                const response = await state.override(sid, data, accepts);
                if (response !== undefined) return response;
            }
            let response;
            if (sid === 0x23 && data[data.length - 1] === 0xFF) {
                assert.deepStrictEqual(data, MARKER_READ);
                response = [0x63].concat(Array.from(state.marker));
            } else if (sid === 0x23) {
                assert.deepStrictEqual(data, MAP_READ);
                response = [0x63, state.slot];
            } else {
                assert.deepStrictEqual(data.slice(0, 6), [0x14, 0x60, 0x03, 0x80, 0x06, 2]);
                assert(Number.isInteger(data[6]) && data[6] >= 0 && data[6] <= 3);
                assert.strictEqual(data[7], 1);
                assert.strictEqual(data.length, 8);
                state.slot = data[6];
                response = [0x7E, 0x3D];
            }
            assert(accepts(response));
            return response;
        } finally { state.active--; }
    };
    const ctl = new Bm3Controller(diag, CONFIG);
    return { ctl, diag, calls, state, writes: () => calls.filter((call) => call.sid === 0x3E) };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('observed public tag is recognized with opaque synthetic metadata', () => {
    const data = marker();
    assert.strictEqual(data.length, 255);
    assert.strictEqual(data[254], 0xA5);
    assert.strictEqual(directMarkerRom(data, profiles, ROM), ROM);
    for (let i = 4; i < 101; i++) data[i] = i % 2 ? 0xFE : 0;
    for (let i = 142; i < data.length; i++) data[i] = i % 2 ? 0x80 : 0;
    assert.strictEqual(directMarkerRom(Array.from(data), profiles, ROM), ROM);
});

const badMarkers = [
    ['truncated payload', (data) => data.slice(0, 254)],
    ['oversize payload', (data) => Buffer.concat([data, Buffer.from([0])])],
    ['wrong signature', (data) => { data[0] = 0x58; return data; }],
    ['high-bit signature spoof', (data) => { for (let i = 0; i < 4; i++) data[i] |= 0x80; return data; }],
    ['legacy marker without the fixed modern record', (data) => { data.fill(0); data.write('BM3_R#F4C9L8R02', 0); return data; }],
    ['shifted tag offset', (data) => { data.fill(0xA5, 101, 142); data.write(TAG, 100); data[140] = 0; return data; }],
    ['missing tag delimiter', (data) => { data[101] = 0; return data; }],
    ['extra hash in opaque metadata', (data) => { data[200] = 0x23; return data; }],
    ['different known ROM', (data) => { data.write('F4C9L8R03', 102); return data; }],
    ['unknown ROM', (data) => { data.write('F4C9L8R99', 102); return data; }],
    ['ROM prefix extension', (data) => { data.write('F4C9L8R020', 102); return data; }],
    ['different model suffix', (data) => { data.write('G82', 117); return data; }],
    ['missing terminator', (data) => { data[141] = 0xA5; return data; }],
    ['early terminator', (data) => { data[128] = 0; return data; }],
    ['nonbyte metadata', (data) => { const values = Array.from(data); values[70] = 256; return values; }]
];
badMarkers.forEach(([name, corrupt]) => test('reject ' + name, () => {
    assert.throws(() => directMarkerRom(corrupt(marker()), profiles, ROM), /marker/);
}));

test('expected and supported ROM cannot be substituted by prefix or inherited property', () => {
    assert.throws(() => directMarkerRom(marker(), profiles, 'F4C9L8R03'), /expected supported profile/);
    assert.throws(() => directMarkerRom(marker(), {}, ROM), /expected supported profile/);
    assert.throws(() => directMarkerRom(marker(), Object.create({ [ROM]: profiles[ROM] }), ROM), /expected supported profile/);
});

test('direct configuration permits only the observed address and exact ROM', () => {
    const value = validateIdentityConfig(CONFIG);
    assert.deepStrictEqual(value, { markerAddress: '807FFE50', identityMode: 'direct-memory', expectedRom: ROM });
    for (const patch of [
        { markerAddress: null }, { markerAddress: '807FFE51' }, { markerAddress: '807FFE50;reboot' },
        { identityMode: null }, { identityMode: 'automatic' }, { expectedRom: null },
        { expectedRom: 'F4C9L8R03' }, { expectedRom: 'F4C9L8R02_suffix' }
    ]) assert.throws(() => validateIdentityConfig(Object.assign({}, CONFIG, patch)));
    assert.strictEqual(validateIdentityConfig({}).markerAddress, null);
});

test('construction sends nothing and configuration cannot be changed after creation', () => {
    const f = fixture();
    assert.deepStrictEqual(f.calls, []);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().configured, true);
    assert.strictEqual(f.ctl.snapshot().valveConfigured, false);
    assert.throws(() => { f.ctl.config.markerAddress = 'DEADBEEF'; }, TypeError);
    assert.throws(() => { f.ctl.config = {}; }, TypeError);
});

test('explicit Identify consists of exactly two read-only physical memory requests', async () => {
    const f = fixture(), found = await f.ctl.identify();
    assert(found.ready);
    assert.strictEqual(found.rom, ROM);
    assert.strictEqual(found.currentMap, 1);
    assert.deepStrictEqual(f.calls.map((call) => [call.sid, call.data]), [[0x23, MARKER_READ], [0x23, MAP_READ]]);
    assert.strictEqual(f.writes().length, 0);
});

test('map/refresh/burble/valve controls cannot bypass initial identification', async () => {
    const f = fixture();
    for (const action of [() => f.ctl.select(2), () => f.ctl.refresh(), () => f.ctl.refreshBurble(),
        () => f.ctl.setBurble(2), () => f.ctl.setValve('open')]) await assert.rejects(action);
    assert.deepStrictEqual(f.calls, []);
});

test('matched profile switches simulated slots with exact SID3E bytes and readback', async () => {
    const f = fixture(); await f.ctl.identify();
    for (const slot of [2, 3, 4, 1]) {
        const before = f.calls.length;
        assert.strictEqual((await f.ctl.select(slot)).currentMap, slot);
        assert.deepStrictEqual(f.calls.slice(before).map((call) => call.sid), [0x23, 0x23, 0x3E, 0x23]);
        assert.deepStrictEqual(f.calls[before + 2].data, [0x14, 0x60, 0x03, 0x80, 0x06, 2, slot - 1, 1]);
    }
    assert.strictEqual(f.writes().length, 4);
    assert.strictEqual(f.state.maxActive, 1);
});

test('fresh current-map read prevents an unnecessary write after an external switch', async () => {
    const f = fixture(); await f.ctl.identify(); f.state.slot = 2;
    assert.strictEqual((await f.ctl.select(3)).currentMap, 3);
    assert.strictEqual(f.writes().length, 0);
    f.state.slot = 3;
    assert.strictEqual((await f.ctl.refresh()).currentMap, 4);
});

test('marker mismatch on revalidation blocks every write and invalidates readiness', async () => {
    const f = fixture(); await f.ctl.identify(); f.state.marker.write('F4C9L8R03', 102);
    await assert.rejects(() => f.ctl.select(2), /verified G87 format/);
    assert.strictEqual(f.writes().length, 0);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});

test('invalid current-slot value cannot enable map controls', async () => {
    const f = fixture(); f.state.slot = 4;
    await assert.rejects(() => f.ctl.identify(), /current-map/);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.writes().length, 0);
});

test('stale short map response during marker read requires transport reset', async () => {
    const f = fixture(); f.state.override = async () => [0x63, 0];
    await assert.rejects(() => f.ctl.identify(), /direct BM3 marker length/);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.ctl.snapshot().transportResetRequired, true);
    f.state.override = null;
    await assert.rejects(() => f.ctl.identify(), /reconnect/);
    assert.strictEqual(f.calls.length, 1);
});

test('stale marker response during map read cannot establish current slot', async () => {
    const f = fixture();
    f.state.override = async () => [0x63].concat(Array.from(marker()));
    await assert.rejects(() => f.ctl.identify(), /current-map/);
    assert.strictEqual(f.ctl.snapshot().transportResetRequired, true);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});

test('negative marker response is surfaced once with no DID/session fallback', async () => {
    const f = fixture(); f.state.override = async () => [0x7F, 0x23, 0x31];
    await assert.rejects(() => f.ctl.identify(), /NRC 31/);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].sid, 0x23);
});

test('timeout blocks reuse until disconnect/reconnect and successful explicit Identify', async () => {
    const f = fixture(); f.state.override = async () => { throw new Error('synthetic timeout'); };
    await assert.rejects(() => f.ctl.identify(), /timeout/);
    await assert.rejects(() => f.ctl.identify(), /reconnect/);
    assert.strictEqual(f.calls.length, 1);
    f.diag.setAvailable(false); f.diag.setAvailable(true); f.state.override = null;
    assert.strictEqual((await f.ctl.identify()).ready, true);
});

test('transport epoch change between marker request and response prevents map reads', async () => {
    const f = fixture();
    f.state.override = async () => {
        f.diag.setAvailable(false); f.diag.setAvailable(true);
        return [0x63].concat(Array.from(marker()));
    };
    await assert.rejects(() => f.ctl.identify(), /changed during/);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.ctl.snapshot().ready, false);
});

test('disconnect after identified state requires another Identify before any map request', async () => {
    const f = fixture(); await f.ctl.identify();
    f.diag.setAvailable(false); f.diag.setAvailable(true);
    const before = f.calls.length;
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    assert.strictEqual(f.calls.length, before);
});

test('concurrent actions are rejected without queuing or overlapping transport calls', async () => {
    const f = fixture(); await f.ctl.identify();
    const first = f.ctl.select(2);
    await assert.rejects(() => f.ctl.select(3), /no action was queued/);
    await assert.rejects(() => f.ctl.identify(), /no action was queued/);
    assert.strictEqual((await first).currentMap, 2);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.state.maxActive, 1);
});

test('lost write acknowledgment latches outcome unknown and is never replayed', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid, data) => {
        if (sid === 0x3E) { f.state.slot = data[6]; throw new Error('lost synthetic acknowledgment'); }
    };
    await assert.rejects(() => f.ctl.select(2), /outcome unknown/);
    assert.strictEqual(f.writes().length, 1);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.ctl.select(2), /Identify/);
    await assert.rejects(() => f.ctl.identify(), /reconnect/);
    assert.strictEqual(f.writes().length, 1);
    f.diag.setAvailable(false); f.diag.setAvailable(true); f.state.override = null;
    const recovered = await f.ctl.identify();
    assert.strictEqual(recovered.currentMap, 2);
    assert.strictEqual(recovered.outcomeUnknown, false);
    assert.strictEqual(f.writes().length, 1);
});

test('mismatched write readback reports unknown and clears displayed map', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => sid === 0x3E ? [0x7E, 0x3D] : undefined;
    await assert.rejects(() => f.ctl.select(2), /outcome unknown.*readback differs/);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    assert.strictEqual(f.ctl.snapshot().currentMap, null);
    assert.strictEqual(f.writes().length, 1);
});

test('disconnect while write is acknowledged never reports a confirmed map', async () => {
    const f = fixture(); await f.ctl.identify();
    f.state.override = async (sid) => {
        if (sid === 0x3E) { f.diag.setAvailable(false); f.diag.setAvailable(true); return [0x7E, 0x3D]; }
    };
    await assert.rejects(() => f.ctl.select(2), /outcome unknown/);
    assert.strictEqual(f.ctl.snapshot().ready, false);
    assert.strictEqual(f.ctl.snapshot().outcomeUnknown, true);
    assert.strictEqual(f.writes().length, 1);
});

(async () => {
    let failures = 0;
    for (const item of tests) {
        try { await item.fn(); console.log('ok - ' + item.name); }
        catch (error) { failures++; console.error('FAIL - ' + item.name + '\n' + error.stack); }
    }
    console.log((tests.length - failures) + '/' + tests.length + ' synthetic direct-identity checks passed; no vehicle capture or transport used.');
    if (failures) process.exitCode = 1;
})().catch((error) => { console.error(error); process.exitCode = 1; });
