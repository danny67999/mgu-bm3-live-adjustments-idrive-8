'use strict';
// Exercise the real Diag implementation with simulated native signal callbacks.
// This does not validate the vehicle bus, iDrive runtime, marker address, or ROM.
// ReadMemoryByAddress (0x23) replies do not echo the address: same-service frames
// from another client/late request cannot be distinguished by this transport.
const assert = require('assert');
const { Diag } = require('../kit/diag');
const { Bm3Controller } = require('../src/controller');

async function fixture(wmbaCmd, direct) {
    const state = { slot: 0, enabled: 1, timing: Array(24).fill(0xFD), busySid: null, calls: [], callback: null };
    const rom = direct ? 'F4C9L8R02' : 'TEST_ROM';
    const markerAddress = direct ? '807FFE50' : '60000200';
    const mapAddress = direct ? '60038006' : '60000000';
    const enableAddress = direct ? '60038099' : '60000099';
    const tableAddress = direct ? '60038100' : '60000100';
    // Synthetic opaque bytes only; the public layout comes from the observed
    // format. No captured DME metadata or license material is in this fixture.
    const marker = Buffer.alloc(255, 0x55);
    marker.write('BM3_', 0, 'ascii');
    marker.write('#F4C9L8R02GGGJM_G87_RWD_USA_KOR_ULEV246_', 101, 'ascii');
    marker[141] = 0;
    const frame = (ecu, uds) => state.callback({ errorCode: 'NO_ERROR', udsResponse: Buffer.from([0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds)) });
    const signals = {
        async proxy() { return {}; },
        async on(proxy, event, callback) { assert.strictEqual(event, 'sendTasuResponse'); state.callback = callback; },
        async onAvailable(proxy, callback) { state.availability = callback; callback(true); },
        async call(proxy, method, request, timeout) {
            assert.strictEqual(method, 'sendTasuRequest');
            assert.strictEqual(timeout, 4500);
            assert.strictEqual(request.sourceAddress, 0xF2);
            assert.strictEqual(request.targetAddress, 0x12);
            const sid = request.serviceID, data = Array.from(request.udsData);
            assert.strictEqual(request.udsDataLength, data.length);
            state.calls.push({ sid, data });
            if (sid === state.busySid) return 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED';
            let response;
            if (sid === 0x2C) {
                assert.deepStrictEqual(data, [2, 0xF3, 1, 0x24, 0x60, 0, 2, 0, 0, 0xFF]);
                response = [0x6C, 2, 0xF3, 1];
            } else if (sid === 0x22) {
                if (data[0] === 0xF1) { assert.deepStrictEqual(data, [0xF1, 0x95]); response = [0x62, 0xF1, 0x95, 1, 2, 3, 4]; }
                else { assert.deepStrictEqual(data, [0xF3, 1]); response = [0x62, 0xF3, 1].concat(Array.from(Buffer.from('BM3_R#TEST_ROM#'))); }
            } else if (sid === 0x23) {
                const address = Buffer.from(data.slice(1, 5)).toString('hex');
                if (direct && address === markerAddress.toLowerCase()) {
                    assert.strictEqual(data[5], 255); response = state.staleMarker ? [0x63, state.slot] : [0x63].concat(Array.from(marker));
                }
                else if (address === mapAddress) { assert.strictEqual(data[5], 1); response = [0x63, state.slot]; }
                else if (address === enableAddress) { assert.strictEqual(data[5], 1); response = [0x63, state.enabled]; }
                else if (address === tableAddress) { assert.strictEqual(data[5], 24); response = [0x63].concat(state.timing); }
                else throw new Error('Unexpected read address');
            } else if (sid === parseInt(wmbaCmd, 16)) {
                const address = Buffer.from(data.slice(1, 5)).toString('hex');
                if (address === mapAddress) {
                    assert.strictEqual(data[5], 2); assert.strictEqual(data[7], 1); assert(data[6] >= 0 && data[6] <= 3); state.slot = data[6];
                } else if (address === enableAddress) { assert.strictEqual(data[5], 1); state.enabled = data[6]; }
                else if (address === tableAddress) { assert.strictEqual(data[5], 24); state.timing = data.slice(6); }
                else throw new Error('Unexpected write address');
                response = sid === 0x3D ? [0x7D] : [0x7E, 0x3D];
            } else if (sid === 0x2F) {
                assert.deepStrictEqual(data, [0x60, 0xFD, 3, 0x14, 0xFE]);
                response = [0x6F, 0x60, 0xFD, 3];
            } else throw new Error('Unexpected diagnostic service');
            setImmediate(() => {
                // A refusal from another ECU must not reject our DME operation.
                frame(0x13, [0x7F, sid, 0x33]);
                // A marker read for a different DID must not satisfy our read.
                if (sid === 0x22) frame(0x12, [0x62, 0xF3, 2].concat(Array.from(Buffer.from('BM3_R#UNKNOWN#'))));
                frame(0x12, response);
            });
            return 'NO_ERROR';
        },
    };
    const diag = new Diag(signals, { info() {}, warn() {} });
    // If a regression restores transport retries, fail quickly instead of waiting
    // the runtime's normal 1+2+3+4 second backoff in the synthetic test.
    diag.busyMs = 1;
    await diag.init();
    const controller = new Bm3Controller(diag, { identityMode: direct ? 'direct-memory' : 'legacy-did', markerAddress,
        expectedRom: direct ? rom : null, verifiedValveAdapter: direct ? null : {
        id: 'bm3-flap-60fd-v1', rom: 'TEST_ROM', softwareIdentityHex: '01020304',
    } }, {
        [rom]: { rom, mapSwActAddr: mapAddress, burbleActAddr: enableAddress, wmbaCmd,
            liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: tableAddress, factor: 2 } } },
    });
    return { state, diag, controller };
}

async function run() {
    for (const sid of ['3d', '3e']) {
        const f = await fixture(sid);
        assert.strictEqual(f.state.calls.length, 0, 'startup must be silent');
        const identified = await f.controller.identify();
        assert.strictEqual(identified.ready, true);
        assert.strictEqual(identified.currentMap, 1);
        const switched = await f.controller.select(4);
        assert.strictEqual(switched.currentMap, 4);
        assert.strictEqual(f.state.slot, 3);
        assert.strictEqual(f.state.calls.filter((c) => c.sid === parseInt(sid, 16)).length, 1);
        assert.strictEqual(f.diag.listenerCount('frame'), 0, 'response listeners must be removed');
        console.log('ok - real Diag identify/switch/readback, ECU and DID filtering, SID ' + sid);
    }
    const f = await fixture('3d');
    await f.controller.identify();
    f.state.busySid = 0x3D;
    await assert.rejects(() => f.controller.select(2), /Switch outcome unknown.*transport refused/);
    assert.strictEqual(f.state.calls.filter((c) => c.sid === 0x3D).length, 1, 'BUSY must never retry a write');
    assert.strictEqual(f.state.slot, 0);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
    assert.strictEqual(f.controller.snapshot().ready, false);
    assert.strictEqual(f.controller.snapshot().transportResetRequired, true);
    assert.strictEqual(f.diag.listenerCount('frame'), 0);
    console.log('ok - real Diag BUSY write verdict is not retried and invalidates readiness');
    for (const sid of ['3d', '3e']) {
        const burble = await fixture(sid); await burble.controller.identify();
        assert.strictEqual((await burble.controller.refreshBurble()).burbleAggression, 1.5);
        assert.strictEqual((await burble.controller.setBurble(4.5)).burbleAggression, 4.5);
        assert.deepStrictEqual(burble.state.timing, Array(24).fill(0xF7));
        assert.strictEqual((await burble.controller.disableBurble()).burbleEnabled, false);
        assert.deepStrictEqual(burble.state.timing, Array(24).fill(0));
        assert.strictEqual(burble.state.calls.filter(call => call.sid === parseInt(sid, 16)).length, 4);
        assert.strictEqual(burble.diag.listenerCount('frame'), 0);
        console.log('ok - real Diag exact burble apply/Off/readbacks, SID ' + sid);
    }
    const valve = await fixture('3e'); await valve.controller.identify();
    const accepted = await valve.controller.setValve('open');
    assert.strictEqual(accepted.valveAcceptedMode, 'open');
    assert.strictEqual(accepted.valvePosition, 'unknown');
    assert.strictEqual(valve.state.calls.filter(call => call.sid === 0x2F).length, 1);
    console.log('ok - real Diag gated community valve reference acknowledgment (not physical position)');
    const direct = await fixture('3e', true);
    direct.state.slot = 1;
    assert.strictEqual(direct.state.calls.length, 0);
    const identity = await direct.controller.identify();
    assert.strictEqual(identity.rom, 'F4C9L8R02');
    assert.strictEqual(identity.currentMap, 2);
    assert.deepStrictEqual(direct.state.calls.map((call) => call.sid), [0x23, 0x23]);
    assert.strictEqual((await direct.controller.select(4)).currentMap, 4);
    assert.strictEqual(direct.state.calls.filter((call) => call.sid === 0x3E).length, 1);
    assert(direct.state.calls.every((call) => [0x23, 0x3E].includes(call.sid)), 'direct mode never defines a DID or changes session');
    console.log('ok - real Diag direct-memory identity and map selection with sanitized modern marker');
    const stale = await fixture('3e', true);
    stale.state.staleMarker = true;
    await assert.rejects(() => stale.controller.identify(), /marker length/);
    assert.strictEqual(stale.controller.snapshot().ready, false);
    assert.strictEqual(stale.controller.snapshot().transportResetRequired, true);
    assert.strictEqual(stale.state.calls.length, 1);
    await assert.rejects(() => stale.controller.identify(), /reconnect|restart/);
    assert.strictEqual(stale.state.calls.length, 1, 'same-service stale response cannot trigger an automatic retry');
    console.log('ok - real Diag stale same-service marker reply locks direct identity without retry');
    console.log('8 simulated native-transport checks passed; no vehicle contacted.');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
