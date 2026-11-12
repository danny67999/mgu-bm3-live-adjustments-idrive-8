'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { BridgeController } = require('../src/bridge');
const operations = [], opened = [], components = new Map(), resources = [], lifecycle = [], traces = [], writes = [], entryOpens = [];
let enabled = false, connections = 0, diagBusy = false, diagCalls = 0, exited = false, diagReady = true, externalInvalidations = 0;
let flushes = 0, failFlush = false, entryGate = null;
const status = () => ({ version: '0.2.0', state: enabled ? 'running' : 'off', configured: true,
    profile: { version: 1, enabled: false, bind_host: '127.0.0.2', interface: 'wlan_bridge',
        upstream_host: '127.0.0.4', upstream_source: '127.0.0.1',
        allowed_clients: ['127.0.0.3'], protocols: ['hsfz'], max_connections: 4 },
    transport: enabled ? { running: true, active_connections: connections } : null, last_error: null });
class Client {
    async request(op) {
        operations.push(op);
        if (op === 'start') enabled = true;
        if (op === 'stop') { assert.strictEqual(connections, 0); enabled = false; }
        return status();
    }
}
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        this.rhmiApplication = Object.assign(new EventEmitter(), {
            getByName(name) {
                if (!components.has(name)) {
                    const id = components.size + 1;
                    components.set(name, Object.assign(new EventEmitter(), {
                        getId: () => id,
                        setValue: async (row, field, value, type) => { writes.push({ name, row, field, value, type, kind: 'value' }); },
                        setProperty: async (field, value, type) => {
                            assert.notStrictEqual(field, 'Enabled', 'runtime must not send native property 1');
                            writes.push({ name, field, value, type, kind: 'property' });
                        },
                        updateResources: async () => { resources.push(name); lifecycle.push('resources:' + name); }
                    }));
                }
                return components.get(name);
            },
            mapEntryState: async () => { lifecycle.push('map'); }, openState: async (name) => { opened.push(name); },
            flush: async () => { flushes++; if (failFlush) throw new Error('Synthetic native batch rejection'); },
            openEntryState: async (uuid) => { entryOpens.push(uuid); if (entryGate) await entryGate; }
        });
        this.appDescription = { application: { entryPoints: [{ uuid: 'test' }] } };
    }
    async initialized() { this.isInitialized = true; this.appStatusService = {}; lifecycle.push('initialized'); }
    async registerActive() { lifecycle.push('active'); }
    async registerHmiVisible() { lifecycle.push('visible'); }
    async unregisterHmiVisible() { lifecycle.push('hidden'); }
    async registerInactive() { lifecycle.push('inactive'); }
    getEntryPoints() {
        return [{ getDescription: () => ({ uuid: 'test', textId: 'test' }), init: async () => {},
            setAvailability: async () => {}, entryPoint: { setText: async () => {} } }];
    }
    async destroyBundles() {}
}
class Diag extends EventEmitter {
    constructor() { super(); this.available = false; }
    async init() { lifecycle.push('diag'); return new Promise(() => {}); }
}
const moduleProbe = { exports: {} };
const source = path.resolve(__dirname, '../src/host.js');
vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module: moduleProbe, __dirname: path.dirname(source), console, setInterval, clearInterval, setTimeout, clearTimeout,
    process: { exit: () => { exited = true; } },
    require(name) {
        if (name === 'oap-sdk/src/core/OnlineApp.js') return OnlineApp;
        if (name === 'oap-sdk/src/logging/logging') return { getSDKLogger: () => ({ warn() {}, error() {} }) };
        if (name === './kit/diag') return { Diag };
        if (name === './sdk_signals') return {};
        if (name === './startup_trace') return { trace(stage) { traces.push(stage); } };
        if (name === './bridge') return { BridgeClient: Client, BridgeController };
        return name.startsWith('.') ? require(path.join(path.dirname(source), name)) : require(name);
    }
}, { filename: source });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
const app = new moduleProbe.exports.Bm3App();
(async () => {
    try {
        app._visibility(true);
        assert(!lifecycle.includes('visible'), 'early visibility must wait for SDK readiness');
        app.emit('appStatusProxyReady');
        await app._appInitialized();
        await settle();
        assert.deepStrictEqual(resources, ['ST_BM3_MAIN', 'ST_BM3_BRIDGE', 'ST_BM3_DATA']);
        assert(lifecycle.indexOf('resources:ST_BM3_BRIDGE') < lifecycle.indexOf('map'));
        assert(lifecycle.indexOf('initialized') < lifecycle.indexOf('diag'), 'unavailable TASU must not block the native app lifecycle');
        assert(lifecycle.includes('active'), 'app status proxy readiness registers ACTIVE');
        app._visibility(true);
        await settle();
        assert.strictEqual(lifecycle.filter((stage) => stage === 'visible').length, 1,
            'early visibility must not suppress the first report once actual SDK fields are ready');
        for (const stage of ['host:super-complete', 'event:appStatusProxyReady', 'ui:init-begin', 'ui:root-resolved',
            'ui:components-bound', 'ui:bridge-resolved', 'ui:resources-begin', 'ui:resources-complete',
            'ui:entry-resolved', 'ui:entry-init-complete', 'ui:entry-mapped', 'ui:entry-enabled',
            'ui:initialized-complete', 'ui:first-render-dispatched', 'ui:last-entry']) assert(traces.includes(stage), stage);
        assert.deepStrictEqual(operations, ['status'], 'startup only inspects local bridge');
        assert(flushes > 0, 'native update batches are flushed and observed');
        const lastText = (name) => writes.filter((write) => write.name === name && write.field === 'PrimaryText').slice(-1)[0].value;
        assert.strictEqual(lastText('BM3_BRIDGE_OPEN'), 'Wi-Fi Bridge');
        assert(lastText('BM3_MAP_1').endsWith(' • unavailable'), 'unidentified map is clearly labelled without removing focus');
        assert(lastText('BM3_BURBLE_APPLY').endsWith(' • unavailable'));
        assert(lastText('BM3_VALVE_OPEN').endsWith(' • unavailable'));
        assert(!writes.some((write) => write.kind === 'property'), 'rendering never rewrites native focus or Enabled properties');
        app._controller.select = async () => { diagCalls++; };
        app._controller.setBurble = async () => { diagCalls++; };
        app._controller.setValve = async () => { diagCalls++; };
        app._press('BM3_MAP_1'); app._press('BM3_BURBLE_APPLY'); app._press('BM3_VALVE_OPEN');
        await settle();
        assert.strictEqual(diagCalls, 0, 'focusable unavailable rows cannot bypass identity/burble/valve guards');
        const beforeWrites = writes.length, beforeFlushes = flushes;
        await Promise.all([app._render(), app._render(), app._render()]);
        components.get('ST_BM3_MAIN').emit('focus', { focus: true });
        await settle();
        app._refreshBridge();
        await settle();
        assert.strictEqual(writes.length, beforeWrites, 'unchanged focus events and background polls do not rewrite rows or reset focus');
        assert.strictEqual(flushes, beforeFlushes, 'unchanged screens produce no native batch');
        const activeBefore = lifecycle.filter((stage) => stage === 'active').length;
        app._visibility(true);
        app._visibility(true);
        assert.strictEqual(lifecycle.filter((stage) => stage === 'active').length, activeBefore, 'repeated visibility does not re-register');
        app._visibility(false);
        let releaseEntry;
        entryGate = new Promise((resolve) => { releaseEntry = resolve; });
        let activated = null;
        app._dashboard = { visibility() {}, deactivate() {}, render: async () => {}, activate(page) { activated = page; } };
        const firstOpen = app._open('test');
        for (let i = 0; i < 4; i++) assert.strictEqual(app._open('test'), firstOpen);
        await settle();
        assert.strictEqual(entryOpens.length, 1, 'duplicate native entry events are coalesced');
        assert.strictEqual(activated, null, 'dashboard stays inactive until entry open is acknowledged');
        releaseEntry(); await firstOpen; entryGate = null;
        assert.strictEqual(activated, 0, 'entry acknowledgement activates Maps even without native focus events');
        app._dashboard = null;
        await app._open('test');
        assert.strictEqual(entryOpens.length, 1, 'already visible entry is not reopened');
        await app._open('unmapped');
        assert.strictEqual(entryOpens.length, 1, 'unmapped SDK entry UUID is not sent to native HMI');
        app._visibility(false);
        await app._open('test');
        assert.strictEqual(entryOpens.length, 2, 'a legitimate open after hiding still works');
        const inactiveBefore = lifecycle.filter((stage) => stage === 'inactive').length;
        app._stateVisibility('main', true);
        app._stateVisibility('main', false);
        app._stateVisibility('bridge', true);
        await settle();
        assert.strictEqual(lifecycle.filter((stage) => stage === 'inactive').length, inactiveBefore, 'state transitions do not mark the app hidden');
        failFlush = true; app._written = {};
        await app._render();
        assert(traces.includes('ui:flush-error'), 'native cached-batch rejection is observed in the trace');
        assert.strictEqual(Object.keys(app._written).length, 0, 'rejected batch invalidates cached values');
        failFlush = false;
        await app._render();
        assert(app._model().buttons.find((b) => b.name === 'BM3_BRIDGE_START').enabled, 'bridge independent of absent DME provider/marker');
        app._press('BM3_BRIDGE_OPEN');
        await settle();
        assert(opened.includes('ST_BM3_BRIDGE'), 'native navigation opens actual bridge state');
        app._controller = { snapshot: () => ({ configured: true, ready: diagReady, currentMap: diagReady ? 1 : null, rom: diagReady ? 'TEST' : null, busy: diagBusy }),
            identify: async () => { diagReady = true; },
            invalidateForExternalSession() { externalInvalidations++; diagReady = false; },
            select: async () => { diagCalls++; } };
        app._diag.available = true;
        diagBusy = true;
        app._press('BM3_BRIDGE_START');
        app._press('BM3_MAP_3');
        await settle();
        assert(!operations.includes('start'), 'no start during pending Live Adjust');
        assert.strictEqual(diagCalls, 0, 'focusability cannot bypass a busy controller');
        diagBusy = false;
        app._lastPress.BM3_BRIDGE_START = 0;
        app._press('BM3_BRIDGE_START');
        await settle();
        assert(enabled);
        assert.strictEqual(externalInvalidations, 1, 'bridge ON invalidates cached DME readiness');
        assert(lastText('BM3_MAP_2').endsWith(' • unavailable'), 'bridge exclusion is visible in the stable map row');
        app._press('BM3_MAP_2');
        await settle();
        assert.strictEqual(diagCalls, 0, 'no DME actions while bridge is on');
        connections = 1;
        app._refreshBridge();
        await settle();
        app._press('BM3_BRIDGE_STOP');
        await settle();
        assert(!operations.includes('stop'), 'active connection blocks UI Stop');
        connections = 0;
        app._refreshBridge();
        await settle();
        app._lastPress.BM3_BRIDGE_STOP = 0;
        app._press('BM3_BRIDGE_STOP');
        await settle();
        assert(!enabled);
        assert(!app._model().buttons.find((b) => b.name === 'BM3_MAP_2').enabled, 'Stop cannot revive an old map cache');
        assert.strictEqual(externalInvalidations, 1, 'repeated ON status polls invalidate only once per session');
        app._press('BM3_MAP_4'); await settle();
        assert.strictEqual(diagCalls, 0, 'fresh Identify is required after phone diagnostics');
        app._press('BM3_IDENTIFY'); await settle();
        assert(!lastText('BM3_MAP_2').includes('unavailable'), 'fresh Identify restores action presentation');
        app._lastPress.BM3_MAP_4 = 0;
        app._press('BM3_MAP_4'); await settle();
        assert.strictEqual(diagCalls, 1, 'only an explicitly pressed ready action reaches the controller');
        assert(!writes.some((write) => write.kind === 'property'), 'busy/bridge/identity transitions never change native focusability');
        const { replies } = require('../emulator/simulated_car_data');
        let releaseData, dataCalls = 0;
        app._diag.physical = async () => { dataCalls++; return new Promise((resolve) => { releaseData = resolve; }); };
        app._press('BM3_DATA_OPEN'); await settle();
        assert(opened.includes('ST_BM3_DATA'), 'native data list remains usable when graphical setup is absent');
        assert.strictEqual(dataCalls, 0, 'opening Vehicle Data sends no diagnostics');
        app._press('BM3_DATA_READ');
        assert(app._data.busy);
        app._lastPress.BM3_MAP_2 = 0; app._press('BM3_MAP_2');
        app._lastPress.BM3_BRIDGE_START = 0; app._press('BM3_BRIDGE_START');
        assert.strictEqual(diagCalls, 1);
        assert(!app._model().buttons.find((b) => b.name === 'BM3_BRIDGE_START').enabled, 'data transaction excludes bridge start');
        app._press('BM3_DATA_STOP');
        assert(app._data.busy, 'Stop does not release diagnostic ownership until the pending response settles');
        releaseData([0x41, 0, 0, 0, 0, 1]); await settle();
        assert.strictEqual(dataCalls, 1, 'cancellation does not continue to the next capability query');
        app._diag.physical = async (ecu, sid, data) => {
            dataCalls++; assert.strictEqual(sid, 1);
            return [0x41, data[0]].concat(replies[data[0]]);
        };
        app._lastPress.BM3_DATA_READ = 0; app._press('BM3_DATA_READ'); await settle();
        assert.strictEqual(app._model().telemetry.values.ethanol.status, 'valid');
        assert(!writes.some((w) => w.name === 'BM3_DATA_DETAIL_STATUS' && /ethanol|50\.2 %/i.test(w.value)));
        app._press('BM3_DATA_LIVE'); await settle(); assert(app._data.live);
        app._visibility(false); assert(!app._data.live && !app._data.active, 'hiding the app stops live reads');
        app._visibility(true); app._setDataPage(true);
        app._bridge._state.stateKnown = false;
        const dataBefore = dataCalls;
        app._lastPress.BM3_DATA_READ = 0; app._press('BM3_DATA_READ'); await settle();
        assert.strictEqual(dataCalls, dataBefore, 'unknown bridge status blocks data before traffic');
        assert.strictEqual(app._model().telemetry.values.ethanol.value, null, 'paused samples cannot look live');
        app._bridge._state.stateKnown = true;
        app._setDataPage(false);
        // Exercise the real host's overlay handoff without a renderer/socket.
        let overlay = true, stoppedOverlay = false, focusedAction = null;
        app._dashboard = {
            active: true,
            deactivate() { this.active = false; overlay = false; app._setDataPage(false); },
            visibility() { overlay = !!(this.active && app._visible); }, render: async () => {},
            invalidate() {}, stop() { stoppedOverlay = true; }
        };
        components.get('ST_BM3_MAIN').emit('focus', { focus: true });
        assert(!overlay, 'returning to the native list hides drawn controls');
        overlay = true; app._dashboard.active = true;
        components.get('ST_BM3_BRIDGE').emit('visible', { visible: true });
        assert(!overlay && app._bridgePage, 'visible native bridge hides overlay before changing page');
        overlay = true; app._dashboard.active = true;
        components.get('ST_BM3_DATA').emit('focus', { focus: true });
        assert(!overlay && app._dataPage, 'native Data focus retains read access after hiding graphics');
        app._visibility(false); assert(!overlay && !app._data.active);
        app._dashboardFocus = { 999: (e) => { focusedAction = e.value; } };
        app.rhmiApplication.emit('userEvent', { eventType: 'FOCUS', sourceId: 999, parameterMap: { 0: true } });
        assert.strictEqual(focusedAction, true, 'raw native FOCUS reaches dashboard proxy handler');
        enabled = true;
        const stopCount = operations.filter((op) => op === 'stop').length;
        app._shutdown();
        await settle();
        assert(exited);
        assert(stoppedOverlay, 'app shutdown closes renderer');
        assert.strictEqual(operations.filter((op) => op === 'stop').length, stopCount, 'closing the app does not interrupt a phone session');
        console.log('Native host bridge integration verified: SDK navigation, unavailable DME independence, local status only on startup, start/stop dispatch, mutual exclusion, active session protection, no shutdown stop.');
    } finally { app._data.setActive(false); clearInterval(app._bridgeTimer); clearTimeout(app._hideTimer); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
