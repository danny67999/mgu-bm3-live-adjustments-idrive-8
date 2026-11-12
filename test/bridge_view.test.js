'use strict';
const assert = require('assert');
const { bridgeView } = require('../src/bridge_view');
const button = (model, action) => model.buttons.find((b) => b.name === 'BM3_BRIDGE_' + action);
const off = { available: true, stateKnown: true, compatible: true, configured: true, enabled: false, connections: 0 };
let model = bridgeView(off);
assert(button(model, 'START').enabled);
assert(!button(model, 'STOP').enabled);
assert(/OFF/.test(model.status));
model = bridgeView(Object.assign({}, off, { enabled: true }));
assert(!button(model, 'START').enabled);
assert(button(model, 'STOP').enabled);
assert(/ON/.test(model.status));
model = bridgeView(Object.assign({}, off, { enabled: true, connections: 1 }));
assert(!button(model, 'STOP').enabled);
assert(/1 active connection/.test(model.status));
assert(/Disconnect BM3/.test(model.detail));
for (const extra of [{ available: false }, { stateKnown: false }, { compatible: false }, { configured: false }, { busy: true }, { outcomeUnknown: true }]) {
    model = bridgeView(Object.assign({}, off, extra));
    assert(!button(model, 'START').enabled, JSON.stringify(extra));
    assert(!button(model, 'STOP').enabled, JSON.stringify(extra));
}
assert(bridgeView(off, true).buttons.every((b) => !b.enabled));
assert(/Router blank/.test(bridgeView(off).detail));
assert(/Setup needed/.test(bridgeView(Object.assign({}, off, { configured: false })).status));
assert(/permission/i.test(bridgeView({ available: false, error: 'Permission denied' }).status));
model = bridgeView(Object.assign({}, off, { profile: { bind_host: '127.0.0.2', allowed_clients: ['127.0.0.3'] } }));
assert(model.detail.includes('127.0.0.2') && model.detail.includes('127.0.0.3'));
console.log('Bridge view verified: ON/OFF, active-client stop lock, setup/permission/unknown states, Live Adjust busy lock, phone instructions.');
