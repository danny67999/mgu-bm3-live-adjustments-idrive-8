'use strict';
const assert = require('assert');
const { Bm3Controller, autoMarkerRom, validateIdentityConfig } = require('../src/controller');
const profiles = require('../vendor/bm3-map-profiles.json');
const config = require('../config/vehicle.json');
const keys = Object.keys(profiles);
function legacy(rom) { const data = Buffer.alloc(255); data.write('BM3_R #' + rom + '\0'); return data; }
function modern(rom, variant) {
    const data = Buffer.alloc(255); data.write('BM3_');
    data.write('#' + rom + (variant || 'ABCDE_G82_AWD_ECE_') + '\0', 101); return data;
}
(async () => {
    assert.strictEqual(config.expectedRom, null);
    assert.strictEqual(validateIdentityConfig(config).identityMode, 'auto-marker');
    keys.forEach((rom) => assert.strictEqual(autoMarkerRom(legacy(rom), profiles), rom));
    keys.filter((rom) => rom.length === 9).forEach((rom) => {
        for (const variant of ['ABCDE_G82_AWD_ECE_', 'Z1234_F87_RWD_USA_', 'GGGJM_G87_RWD_USA_KOR_ULEV246_']) {
            assert.strictEqual(autoMarkerRom(modern(rom, variant), profiles), rom);
        }
    });
    const rom = keys.find((key) => key.length === 9);
    for (const payload of [legacy('UNKNOWN'), legacy(rom + '_WRONG'), modern('ZZZZZZZZZ'),
        modern(rom, '0ABCDE_G82_AWD_ECE_'), modern(rom, 'ABCDE_G82_AWD_ECE_#OTHER'), Buffer.alloc(255),
        modern(rom).slice(0, 254)]) assert.throws(() => autoMarkerRom(payload, profiles));
    const high = modern(rom); high[102] |= 128;
    assert.throws(() => autoMarkerRom(high, profiles));
    const shifted = Buffer.concat([Buffer.from([0]), modern(rom).slice(0,254)]);
    assert.throws(() => autoMarkerRom(shifted, profiles));
    const prototype = Object.create({ INHERITED: {} });
    assert.throws(() => autoMarkerRom(legacy('INHERITED'), prototype));
    assert.throws(() => validateIdentityConfig(Object.assign({},config,{markerAddress:'01020304'})));

    // Exercise two different profile write services end-to-end using synthetic
    // marker/current-map responses. No request leaves this fake transport.
    const cases = keys.flatMap((rom) => [{ rom, marker: legacy, layout: 'legacy' }].concat(
        rom.length === 9 ? [{ rom, marker: modern, layout: 'modern' }] : []));
    for (const scenario of cases) {
        const selected = scenario.rom, service = profiles[selected].wmbaCmd;
        const profile = profiles[selected], calls = []; let slot = 0, reportedRom = selected;
        const diag = { available:true, physical: async (ecu,sid,data) => {
            calls.push({ecu,sid,data:data.slice()});
            if (sid === 0x23 && data[data.length-1] === 255) return [0x63].concat(Array.from(scenario.marker(reportedRom)));
            if (sid === 0x23) { assert.deepStrictEqual(data, [0x14].concat(Array.from(Buffer.from(profile.mapSwActAddr,'hex')),[1])); return [0x63,slot]; }
            assert.strictEqual(sid, parseInt(service,16));
            assert.deepStrictEqual(data.slice(1,5),Array.from(Buffer.from(profile.mapSwActAddr,'hex')));
            slot=data[6]; return service === '3e' ? [0x7E,0x3D] : [0x7D];
        }};
        const controller = new Bm3Controller(diag,config);
        assert.strictEqual(calls.length,0);
        await controller.identify(); assert.strictEqual(controller.snapshot().rom,selected);
        for (const map of [1, 2, 3, 4]) {
            await controller.select(map);
            assert.strictEqual(controller.snapshot().currentMap, map, selected + '/' + scenario.layout);
        }
        assert.strictEqual(calls.filter((c)=>c.sid!==0x23).length,3, 'selecting the already-active first slot must not write');
        reportedRom='UNKNOWN'; const before=calls.length;
        await assert.rejects(controller.select(2));
        assert(calls.slice(before).every((c)=>c.sid===0x23),'unknown ROM never authorizes a write');
        assert.strictEqual(controller.snapshot().ready,false);
    }
    console.log('Compatibility: ' + cases.length + ' ROM/layout scenarios, all four map slots with readback, profile changes, both write services and side-effect-free startup passed (synthetic only).');
})().catch((error)=>{console.error(error);process.exitCode=1;});
