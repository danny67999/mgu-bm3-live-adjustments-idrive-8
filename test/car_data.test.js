'use strict';
const assert = require('assert');
const { CarDataReader, channels, supports } = require('../src/car_data');
const { carDataView } = require('../src/car_data_view');
const { SimulatedCarData, replies } = require('../emulator/simulated_car_data');
const { Diag } = require('../kit/diag');

function fixture(diag) {
    let now = 10000, changed = 0, reason = null;
    const timers = new Map(); let id = 0;
    const reader = new CarDataReader(diag || new SimulatedCarData(), {
        now: () => now, onChange: () => changed++, blocked: () => reason,
        setTimer: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
        clearTimer: (key) => timers.delete(key)
    });
    return { reader, timers, get changed() { return changed; }, setReason: (r) => { reason = r; },
        advance: (ms) => {
            now += ms;
            Array.from(timers).forEach(([key, t]) => { if (timers.has(key) && t.at <= now) { timers.delete(key); t.fn(); } });
        } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
    const f = fixture(), r = f.reader, diag = r.diag;
    r.snapshot(); carDataView(r.snapshot()); r.setActive(true);
    assert.strictEqual(diag.calls.length, 0, 'construction, snapshots, and page activation generate no traffic');
    assert(await r.read());
    assert.deepStrictEqual(diag.calls.map((c) => c.data[0]), [0, 0x20, 0x40, 0x0C, 0x0B, 0x0D, 0x33, 0x52, 0x05, 0x0F, 0x42, 0x5C, 0x2F]);
    assert(diag.calls.every((c) => c.ecu === 0x12 && c.sid === 1 && c.data.length === 1), 'only Mode 01 reads');
    const v = r.snapshot().values;
    assert(Math.abs(v.ethanol.value - 50.1960784314) < 1e-8);
    assert.strictEqual(v.rpm.value, 2000); assert.strictEqual(v.speed.value, 0);
    assert.strictEqual(v.coolant.value, 90); assert.strictEqual(v.oil.value, 105); assert.strictEqual(v.intake.value, 30);
    assert.strictEqual(v.voltage.value, 14.74); assert(Math.abs(v.fuel.value - 62.7450980392) < 1e-8);
    assert(Math.abs(v.boost.value - 7.251886887) < 1e-6, 'boost is gauge pressure, not absolute MAP');
    assert(!('ethanol' in carDataView(r.snapshot()).metrics));
    assert.strictEqual(v.ethanol.sampledAt, 10000);
    const ethanol = channels.find((c) => c.key === 'ethanol');
    assert.strictEqual(ethanol.decode([0]), 0); assert.strictEqual(ethanol.decode([255]), 100);
    const cappedDiag = new SimulatedCarData();
    const normalPhysical = cappedDiag.physical.bind(cappedDiag);
    cappedDiag.physical = async (ecu, sid, data) => data[0] === 0x0B ? [0x41, 0x0B, 255] : normalPhysical(ecu, sid, data);
    const capped = fixture(cappedDiag); capped.reader.setActive(true); await capped.reader.read();
    const cappedBoost = carDataView(capped.reader.snapshot()).metrics.boost;
    assert(cappedBoost.value.startsWith('>=')); assert.strictEqual(cappedBoost.status, 'RANGE LIMIT');
    capped.reader.setActive(false);
    const beforeExpiry = f.changed;
    f.advance(5001);
    assert(f.changed > beforeExpiry, 'one-shot samples trigger a redraw on expiry without another user action');
    assert.strictEqual(r.snapshot().values.ethanol.status, 'stale');
    assert.strictEqual(r.snapshot().values.ethanol.value, null);
    assert(!('ethanol' in carDataView(r.snapshot()).metrics));
    assert(!('ethanol' in carDataView(r.snapshot()).metrics));
    assert(!('ethanol' in carDataView(r.snapshot()).metrics));
    await r.read(); assert.strictEqual(diag.calls.filter((c) => c.data[0] === 0).length, 1, 'capabilities cached for this connection');
    r.invalidate(); await r.read(); assert.strictEqual(diag.calls.filter((c) => c.data[0] === 0).length, 2, 'connection invalidation clears capabilities');

    assert(supports([0x80, 0, 0, 0], 0, 1));
    assert(supports([0, 0, 0, 1], 0, 32));
    assert(supports([0, 0, 0x40, 0], 64, 82));
    assert(!supports([255, 255, 255, 255], 0, 33));
    const subsetDiag = new SimulatedCarData();
    subsetDiag.physical = async (ecu, sid, data) => {
        subsetDiag.calls.push(data[0]);
        return [0x41, data[0]].concat(data[0] === 0 ? [0, 0x10, 0, 0] : [0, 0]);
    };
    const subset = fixture(subsetDiag); subset.reader.setActive(true); await subset.reader.read();
    assert.deepStrictEqual(subsetDiag.calls, [0, 0x0C], 'unsupported ranges and channels are never probed');
    assert.strictEqual(subset.reader.snapshot().values.ethanol.status, 'unsupported');
    assert.strictEqual(subset.reader.snapshot().values.rpm.value, 0);
    assert(!('ethanol' in carDataView(subset.reader.snapshot()).metrics));
    assert(!/ethanol|E%/.test(subset.reader.snapshot().status));

    const slow = fixture(), cycleResults = [];
    slow.reader.onCycle = (result) => cycleResults.push(result);
    const slowPhysical = slow.reader.diag.physical.bind(slow.reader.diag);
    slow.reader.diag.physical = async (...args) => { slow.advance(650); return slowPhysical(...args); };
    slow.reader.setActive(true); assert(await slow.reader.read());
    assert.strictEqual(slow.reader.snapshot().values.rpm.value, null, 'old first sample must not claim to be fresh');
    assert.strictEqual(carDataView(slow.reader.snapshot()).metrics.rpm.value, '2000', 'slow batch retains labelled last sample');
    assert.strictEqual(carDataView(slow.reader.snapshot()).metrics.rpm.status, 'LAST SAMPLE');
    assert(cycleResults[0].elapsedMs > 5000 && cycleResults[0].ethanolSupported);
    assert(Array.from(slow.timers.values()).every((timer) => timer.at >= 10000), 'expiry timers remain scheduled');
    assert(slow.timers.size <= 1, 'at most one coalesced expiry notification');
    slow.setReason('Wi-Fi bridge active');
    assert(!('ethanol' in carDataView(slow.reader.snapshot()).metrics), 'ethanol is hidden');
    slow.reader.setActive(false);

    // At the car's observed ~200 ms/request, RPM reaches the view before
    // temperatures finish. Live passes read fast channels plus two rotating
    // slow channels, keeping every advertised channel covered without retries.
    const priority = fixture(), updates = [], cycles = [];
    const priorityPhysical = priority.reader.diag.physical.bind(priority.reader.diag);
    priority.reader.diag.physical = async (...args) => { priority.advance(200); return priorityPhysical(...args); };
    priority.reader.changed = () => updates.push(priority.reader.snapshot());
    priority.reader.onCycle = (cycle) => cycles.push(cycle);
    priority.reader.setActive(true); assert(await priority.reader.start());
    assert.strictEqual(cycles[0].sampledChannels.length, 5);
    assert(cycles[0].firstUpdateMs < cycles[0].elapsedMs);
    assert(updates.some((s) => s.values.rpm.status === 'valid' && s.values.oil.status === 'unread'),
        'fast values publish before the slow group');
    assert(updates.filter((s) => s.live).every((s) => s.busy), 'live ownership does not flicker between passes');
    for (let pass = 0; pass < 4; pass++) { priority.advance(500); await tick(); }
    assert(cycles.length >= 5);
    const warm = cycles.slice(1);
    assert(warm.every((cycle) => cycle.sampledChannels.length === 5 && cycle.firstUpdateMs === 600 && cycle.elapsedMs === 1000),
        'warm fast updates take three requests, not the complete ten-channel batch');
    assert(warm.every((cycle) => ['rpm', 'manifold', 'speed'].every((key) => cycle.sampledChannels.includes(key))));
    assert(channels.every((channel) => cycles.some((cycle) => cycle.sampledChannels.includes(channel.key))),
        'round robin cannot starve temperatures, voltage, barometer, fuel or ethanol');
    assert.strictEqual(priority.reader.snapshot().values.boost.status, 'valid');
    priority.reader.stop(); priority.advance(5001);
    assert.strictEqual(priority.reader.snapshot().values.boost.value, null, 'expired pressure never remains live');
    priority.reader.setActive(false);

    // Stop mid-pass keeps completed samples but discards the response that
    // arrives after cancellation; no next PID can be sent after Stop.
    const partial = fixture(); partial.reader.setActive(true); await partial.reader.read();
    let resume; const sent = [];
    partial.reader.diag.physical = async (ecu, sid, bytes) => {
        sent.push(bytes[0]);
        if (sent.length === 1) return [0x41, 0x0C, 0x0F, 0xA0];
        return new Promise((resolve) => { resume = resolve; });
    };
    const interrupted = partial.reader.start(); await tick();
    partial.reader.stop(); assert(partial.reader.busy);
    resume([0x41, 0x0B, 200]); await interrupted;
    assert.deepStrictEqual(sent, [0x0C, 0x0B]);
    assert.strictEqual(partial.reader.snapshot().values.rpm.value, 1000);
    assert.strictEqual(partial.reader.snapshot().values.manifold.value, 150, 'late cancelled sample not committed');
    partial.reader.setActive(false);

    const empty = fixture({ available: true, physical: async (ecu, sid, data) => [0x41, data[0], 0, 0, 0, 0] });
    empty.reader.setActive(true); await empty.reader.start();
    assert.strictEqual(empty.reader.live, false); assert.strictEqual(empty.timers.size, 0, 'no live retry loop without supported channels');
    assert.strictEqual(empty.reader.snapshot().values.boost.status, 'unsupported');

    for (const badReply of [null, [0x41, 0, 0], [0x41, 0x20, 0, 0, 0, 0], [0x7F, 1, 0x31], [0x41, 0, 256, 0, 0, 0]]) {
        let calls = 0;
        const failed = fixture({ available: true, physical: async () => { calls++; return badReply; } });
        failed.reader.setActive(true); assert.strictEqual(await failed.reader.start(), false);
        assert.strictEqual(calls, 1, 'bad, rejected, mismatched or missing responses stop the cycle');
        assert.strictEqual(failed.reader.live, false); assert.strictEqual(failed.reader.busy, false);
        assert.strictEqual(failed.timers.size, 0, 'no implicit diagnostic retry');
    }

    // Cancellation does not release the diagnostic lock before an in-flight
    // response settles, and never sends the next PID or commits a late response.
    let release, calls = 0;
    const pending = fixture({ available: true, physical: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
    pending.reader.setActive(true); const operation = pending.reader.start();
    assert(pending.reader.busy); assert.strictEqual(await pending.reader.read(), false);
    pending.reader.stop(); assert(pending.reader.busy);
    release([0x41, 0, 0, 0, 0, 1]); await operation;
    assert.strictEqual(calls, 1); assert(!pending.reader.busy && !pending.reader.live);
    assert.strictEqual(pending.reader.snapshot().values.ethanol.status, 'unread');

    const live = fixture(); live.reader.setActive(true); await live.reader.start();
    const readCount = live.reader.diag.calls.length;
    live.setReason('Wi-Fi bridge active'); live.advance(2000); await tick();
    assert.strictEqual(live.reader.diag.calls.length, readCount, 'bridge/Live Adjust gate is rechecked before every live cycle');
    assert(!live.reader.live); assert.strictEqual(live.reader.snapshot().values.ethanol.value, null);
    live.setReason(null); await live.reader.start();
    live.reader.setActive(false); const leaveCount = live.reader.diag.calls.length;
    live.advance(10000); await tick();
    assert.strictEqual(live.reader.diag.calls.length, leaveCount, 'leaving Data cancels all scheduled traffic');
    assert.strictEqual(live.timers.size, 0);
    live.reader.setActive(true); assert.strictEqual(live.reader.diag.calls.length, leaveCount, 'returning to Data does not auto-resume');
    live.reader.diag.available = false; assert.strictEqual(await live.reader.start(), false);
    assert.strictEqual(live.reader.diag.calls.length, leaveCount);

    // Exercise the real transport's physical source and accept-function path.
    // Wrong-ECU and wrong-PID replies arrive before the valid response.
    const transport = new Diag({}, { warn() {} }); transport.available = true;
    transport.send = async (ecu, sid, data, opts) => {
        assert.strictEqual(opts.maxRetries, 0);
        setImmediate(() => {
            transport.emit('frame', { ecu: 0x13, uds: [0x41, data[0], 0, 0, 0, 0] });
            transport.emit('frame', { ecu, uds: [0x41, 0xFF, 0, 0, 0, 0] });
            transport.emit('frame', { ecu, uds: [0x41, data[0]].concat(replies[data[0]]) });
        });
        return 'NO_ERROR';
    };
    const actual = fixture(transport); actual.reader.setActive(true);
    assert(await actual.reader.read()); assert.strictEqual(actual.reader.snapshot().values.rpm.value, 2000);
    assert.strictEqual(transport.listenerCount('frame'), 0, 'no response handlers left behind');

    // Failed subsequent cycle clears old numbers instead of presenting them live.
    diag.physical = async () => null; assert.strictEqual(await r.read(), false);
    assert.strictEqual(r.snapshot().values.ethanol.value, null);
    assert.strictEqual(r.snapshot().values.ethanol.status, 'stale');
    [f, subset, empty, pending, live, actual].forEach((x) => x.reader.setActive(false));
    assert.strictEqual(channels.length, 10);
    console.log('Car data verified: capability-only reads, formulas, unsupported channels, real response filtering, expiry redraws, cancellation, no retries, and diagnostic ownership gates.');
})().catch((e) => { console.error(e); process.exitCode = 1; });
