'use strict';
const assert = require('assert');
const { view } = require('../src/view');
const { Bm3Controller } = require('../src/controller');

// Exercise the UI with real controller snapshots so a future state change cannot
// silently leave the map controls enabled after a disconnect/error.
const diag = { available: true, physical() { throw new Error('UI must not send diagnostics'); } };
const controller = new Bm3Controller(diag, { markerAddress: null });
const initial = view(controller.snapshot(), true, null);
assert(initial.buttons.every((button) => !button.enabled));
assert(/verified.*marker/i.test(initial.status));
const ready = { configured: true, busy: false, ready: true, rom: 'TEST', currentMap: 2 };
for (const slot of [1, 2, 3, 4]) {
    const model = view(Object.assign({}, ready, { currentMap: slot }), true, null);
    assert.strictEqual(model.buttons.filter((b) => /active/.test(b.text)).length, 1);
    assert(model.buttons.find((b) => b.name === 'BM3_MAP_' + slot).text.includes('active'));
    assert(model.buttons.filter((b) => b.name.startsWith('BM3_MAP')).every((b) => b.enabled));
}
for (const model of [
    view(ready, false, null),
    view(Object.assign({}, ready, { busy: true }), true, null),
    view(ready, true, 'Invalid configuration')
]) assert(model.buttons.every((b) => !b.enabled));
const failed = { configured: true, busy: false, ready: false, rom: null, currentMap: null, outcomeUnknown: true };
const uncertain = view(failed, true, null);
assert(/unknown/i.test(uncertain.status));
assert(uncertain.buttons.filter((b) => b.name !== 'BM3_IDENTIFY').every((b) => !b.enabled));
const quarantined = view(Object.assign({}, failed, { transportResetRequired: true }), true, null);
assert(quarantined.buttons.every((b) => !b.enabled));
assert(/restart|reconnect|reset/i.test(quarantined.status));
assert(!JSON.stringify(initial).includes('93'));
const rejected = view(Object.assign({}, failed, { outcomeUnknown: false, error: 'DME rejected request: NRC 31 (request out of range)' }), true);
assert.strictEqual(rejected.status, 'DME rejected request: NRC 31 (request out of range)');
const detailed = view(Object.assign({}, failed, { error: 'Valve outcome unknown: no matching DME response' }), true);
assert(detailed.status.includes('no matching DME response'), 'underlying error is not replaced by the generic unknown warning');
const timeoutDetail = view(Object.assign({}, failed, { transportResetRequired: true, error: 'Valve outcome unknown: timeout' }), true);
assert(timeoutDetail.status.includes('timeout'));
assert(/reopen/.test(timeoutDetail.valveStatus));
console.log('UI states verified: initial lock, four slots, offline/busy/error locks, unknown outcome, reset requirement.');
const identified = view(ready, true, null);
assert(identified.buttons.find((b) => b.name === 'BM3_BURBLE_READ').enabled);
assert(identified.buttons.filter((b) => /^BM3_BURBLE_(DOWN|UP|APPLY|OFF)$/.test(b.name)).every((b) => !b.enabled));
const burbles = Object.assign({}, ready, { burbleReady: true, burbleEnabled: true, burbleAggression: 3.5, burbleCustom: false });
let model = view(burbles, true, null);
assert.strictEqual(model.burbleTarget, 3.5);
assert(/3\.5/.test(model.burbleStatus));
assert(model.buttons.filter((b) => b.name.startsWith('BM3_BURBLE_')).every((b) => b.enabled));
model = view(burbles, true, null, { burbleTarget: 0 });
assert(!model.buttons.find((b) => b.name === 'BM3_BURBLE_DOWN').enabled);
assert(model.buttons.find((b) => b.name === 'BM3_BURBLE_UP').enabled);
model = view(burbles, true, null, { burbleTarget: 12 });
assert(!model.buttons.find((b) => b.name === 'BM3_BURBLE_UP').enabled);
assert(model.buttons.find((b) => b.name === 'BM3_BURBLE_DOWN').enabled);
assert(/custom timing/.test(view(Object.assign({}, burbles, { burbleCustom: true, burbleAggression: null }), true).burbleStatus));
assert(/Off/.test(view(Object.assign({}, burbles, { burbleEnabled: false }), true).burbleStatus));
assert(/does not restore/.test(model.burbleStatus));
for (const state of [Object.assign({}, burbles, { busy: true }), Object.assign({}, burbles, { transportResetRequired: true })]) {
    assert(view(state, true).buttons.filter((b) => b.name.startsWith('BM3_BURBLE_')).every((b) => !b.enabled));
}
console.log('Burble UI verified: explicit read gate, 0–12 half-step selection bounds, custom/off states, uncertainty lock.');
const valveState = Object.assign({}, ready, { valveConfigured: true, valveExperimental: true });
const valveButtons = (model) => model.buttons.filter((b) => b.name.startsWith('BM3_VALVE_'));
assert(valveButtons(view(valveState, true)).every((b) => b.enabled));
assert(!/Experimental/.test(view(valveState, true).valveStatus));
for (const model of [view(ready, true), view(valveState, false), view(valveState, true, 'Wi-Fi bridge active'),
    view(Object.assign({}, valveState, { ready: false }), true),
    view(Object.assign({}, valveState, { busy: true }), true),
    view(Object.assign({}, valveState, { transportResetRequired: true }), true)]) {
    assert(valveButtons(model).every((b) => !b.enabled));
}
const accepted = view(Object.assign({}, valveState, { valveAcceptedMode: 'open' }), true);
assert(/Last valve command accepted: open/.test(accepted.valveStatus));
assert(/physical position not measured/.test(accepted.valveStatus));
assert(!valveButtons(accepted).some((b) => /pending|active/.test(b.text)));
console.log('Valve UI verified: explicit adapter and identity, bridge/offline/busy/reset locks, acknowledgment is not position.');
