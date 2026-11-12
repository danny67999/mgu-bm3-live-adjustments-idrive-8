'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { DashboardHost } = require('../src/dashboard_host');
const { pages } = require('../src/dashboard');
const { W, H, drawFrame } = require('../src/dashboard_frame');
const { view } = require('../src/view');
const { bridgeView } = require('../src/bridge_view');
const { carDataView } = require('../src/car_data_view');
const { CarDataReader } = require('../src/car_data');
const { SimulatedCarData } = require('../emulator/simulated_car_data');
// Capability/geometry fixture from the read-only head-unit handshake. No
// vehicle address, credentials, diagnostic capture or SDK is needed here.
const screen = { w: 2880, h: 960 };
const info = { modes: ['layer'], frontGate: true, pixmap: true, controller: false,
    pixmapSide: 2048, appArea: { x: 0, y: 76, w: 2880, h: 764 } };
class GPU extends EventEmitter {
    constructor() { super(); this.ready = false; this.visible = false; this.frames = []; this.uploads = []; }
    fps(n) { this.rate = n; }
    connect() { this.connected = true; }
    close() { this.closed = true; this.ready = false; }
    mode(m) { this.selectedMode = m; }
    place(p) { this.placement = p; }
    pixmap(id, w, h, format, filter) { this.pixmapArgs = { id, w, h, format, filter }; }
    claim(rects) { this.claims = rects; }
    show(on) { this.visible = !!on; }
    pixels(id, rects, data) { this.uploads.push({ id, rects, length: data.length }); }
    presentPixmap(id, data, frame) { this.pixels(id, [{ x: 0, y: 0, w: W, h: H }], data); this.frameWords(frame); }
    frameWords(frame) { this.frames.push(Array.from(frame)); }
    handshake(capabilities) { this.ready = true; this.emit('ready', screen, capabilities === undefined ? info : capabilities); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm3-dashboard-'));
const components = new Map(), writes = [], actions = [], opened = [];
let flushHook = null, flushCount = 0, dataActive = false;
let state = { ready: true, configured: true, currentMap: 2, rom: 'F4C9L8R02', burbleReady: true, burbleEnabled: true, burbleAggression: 3 };
const bs = { stateKnown: true, available: true, compatible: true, configured: true, enabled: false, connections: 0 };
const model = () => {
    const m = view(state, true, null, {}), bridge = bridgeView(bs, false);
    m.bridgeStatus = bridge.status; m.bridgeDetail = bridge.detail;
    m.buttons = m.buttons.concat(bridge.buttons, carDataView().buttons);
    return m;
};
const app = Object.assign(new EventEmitter(), {
    _actions: {}, _visible: false, _model: model,
    _controller: { snapshot: () => state }, _bridge: { snapshot: () => bs },
    _stateVisibility(name, visible) { if (visible) this._visible = true; },
    _refreshBridge() {}, _setDataPage(active) { dataActive = active; },
    _press(action) { if (model().buttons.find((b) => b.name === action && b.enabled)) actions.push(action); },
    rhmiApplication: {
        getByName(name) {
            if (!components.has(name)) {
                const id = components.size + 1;
                components.set(name, Object.assign(new EventEmitter(), {
                    getId: () => id, updateResources: async () => {},
                    setValue: async (row, field, value, type) => writes.push({ name, row, field, value, type })
                }));
            }
            return components.get(name);
        },
        flush: async () => { flushCount++; if (flushHook) await flushHook(); },
        openState: async (name) => opened.push(name)
    }
});
const gpu = new GPU(), dash = new DashboardHost(app, { client: gpu }); dash.directory = dir;
app._render = () => dash.render();
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); await dash.render(); };
const tap = (x, y) => { gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); };
(async () => {
    await dash.init();
    assert.strictEqual(dash.latest, undefined, 'entry setup does not rasterize before native registration');
    await dash.render();
    assert.strictEqual(fs.readdirSync(dir).length, 0, 'normal rendering does not encode or retain PNG screenshots');
    assert.strictEqual(dash.sequence, 0);
    dash.captureFrames = true;
    assert.strictEqual(actions.length, 0, 'startup must not execute diagnostics');
    assert(!gpu.visible && !dash.heartbeat, 'initialization alone cannot cover the native screen');
    assert.strictEqual(gpu.uploads.length, 0, 'no upload before capabilities');
    assert(writes.some((w) => w.name === 'DASH_2_1' && /unavailable/.test(w.value)), 'native fallback keeps unconfigured valves unavailable');
    assert(writes.some((w) => w.name === 'DASH_2_0' && w.value === 'Identify BM3'), 'Valves page offers identification directly');
    const before = writes.length, flushes = flushCount, sequence = dash.sequence;
    const retainedCanvas = dash.latest.d, retainedContent = dash.canvases.content.d;
    await dash.render();
    assert.strictEqual(writes.length, before); assert.strictEqual(flushCount, flushes); assert.strictEqual(dash.sequence, sequence);
    gpu.handshake(); await settle();
    assert.deepStrictEqual(gpu.pixmapArgs, { id: 1, w: W, h: H, format: 'rgba', filter: 'linear' });
    assert.strictEqual(gpu.selectedMode, 'layer');
    assert.strictEqual(gpu.placement.y, 76); assert.strictEqual(gpu.placement.h, 764);
    assert.strictEqual(gpu.placement.scale, 764 / H);
    assert.strictEqual(gpu.uploads[0].length, W * H * 4);
    assert(gpu.claims[0].x < 0, 'letterbox taps cannot leak to covered native buttons');
    assert(!gpu.visible, 'ready renderer remains hidden until app/page visible');
    components.get('ST_BM3_DASH_0').emit('visible', { visible: true }); await settle();
    assert(gpu.visible && dash.heartbeat, 'foreground dashboard has a keepalive');
    components.get('DASH_0_2').emit('focus', { value: true }); await settle();
    assert.strictEqual(dash.focus, 'BM3_MAP_2');
    assert.strictEqual(writes.length, before, 'rotary highlight changes do not rewrite native rows or reset focus');
    const rawId = components.get('DASH_0_3').getId();
    app._dashboardFocus[rawId]({ value: 1 }); await settle();
    assert.strictEqual(dash.focus, 'BM3_MAP_3', 'raw SDK FOCUS path updates highlight');
    components.get('DASH_0_2').emit('action');
    assert.deepStrictEqual(actions, ['BM3_MAP_2']);
    const map4 = dash.regions.find((r) => r.action === 'BM3_MAP_4');
    tap(map4.x + 20, map4.y + 20); await settle();
    assert.deepStrictEqual(actions, ['BM3_MAP_2', 'BM3_MAP_4']);
    const map1 = dash.regions.find((r) => r.action === 'BM3_MAP_1');
    gpu.emit('touch', 'down', map1.x + 20, 550);
    gpu.emit('touch', 'move', map1.x + 70, 550);
    gpu.emit('touch', 'up', map1.x + 20, 550);
    tap(-100, 200); tap(100, 200);
    assert.strictEqual(actions.length, 2, 'drag, letterbox and decorative card do not activate a command');
    const next = components.get('DASH_0_PAGE');
    next.emit('action'); app._dashboardNav[next.getId()](); await settle();
    assert.deepStrictEqual(opened, ['ST_BM3_DASH_1'], 'duplicated native ACTION navigates once');
    assert.strictEqual(dash.paintedPage, 1);
    const hiddenBefore = gpu.uploads.length;
    app._visible = false; dash.visibility();
    assert(!gpu.visible && !dash.heartbeat);
    tap(500, 30); assert.strictEqual(opened.length, 1, 'hidden touch cannot navigate');
    app._visible = true; dash.visibility();
    tap(900, 30); await settle();
    assert.strictEqual(dash.page, 2, 'header tabs navigate through native states');
    const openValve = dash.regions.find((r) => r.action === 'BM3_VALVE_OPEN');
    tap(openValve.x + 20, 550); await settle();
    assert.strictEqual(actions.length, 2, 'touch cannot bypass unconfigured valve guard');
    state = Object.assign({}, state, { valveConfigured: true, valveExperimental: true });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 360)); // distinct tap, beyond the duplicate-event debounce
    tap(openValve.x + 20, 550); await settle();
    components.get('DASH_2_2').emit('action'); await settle();
    assert.deepStrictEqual(actions.slice(-2), ['BM3_VALVE_OPEN', 'BM3_VALVE_CLOSED'],
        'enabled valve actions work through graphical touch and native rotary action');
    state = Object.assign({}, state, { ready: false }); await settle();
    const beforeValve = actions.length;
    await new Promise((resolve) => setTimeout(resolve, 360));
    tap(openValve.x + 20, 550); components.get('DASH_2_3').emit('action'); await settle();
    assert.strictEqual(actions.length, beforeValve, 'lost identity disables both touch and native valve actions');
    state = Object.assign({}, state, { ready: true }); await settle();
    assert(gpu.uploads.length > hiddenBefore);
    await dash.open(4); assert(dataActive);
    components.get('ST_BM3_DASH_2').emit('visible', { visible: false });
    assert(dataActive && gpu.visible, 'late hide from previous page cannot hide current Data page');
    components.get('ST_BM3_DASH_4').emit('visible', { visible: false });
    assert(!dataActive && !gpu.visible && !dash.heartbeat, 'leaving page stops data and hides overlay');
    await dash.open(0); const uploadCount = gpu.uploads.length;
    gpu.ready = false; gpu.emit('close');
    assert(!gpu.visible && !dash.rendererReady && !dash.heartbeat);
    gpu.handshake(); await settle();
    assert(gpu.visible && gpu.uploads.length > uploadCount, 'reconnect reuploads cached pixels and recovers only active view');
    gpu.emit('renderer-error', 'test failure');
    assert(!gpu.visible && !dash.heartbeat, 'renderer errors uncover the usable native buttons');
    gpu.handshake(); await settle();
    gpu.emit('closed'); assert(!gpu.visible && !dash.active, 'renderer CLOSE cannot immediately reshow');
    for (const bad of [null, Object.assign({}, info, { frontGate: false }), Object.assign({}, info, { pixmap: false }),
        Object.assign({}, info, { pixmapSide: 1024 }), Object.assign({}, info, { modes: [] }),
        Object.assign({}, info, { appArea: { x: 0, y: 76, w: 2880, h: 9999 } })]) {
        gpu.handshake(bad); await dash.open(0);
        assert(!gpu.visible && !dash.heartbeat, 'unsupported renderer uses native fallback');
    }
    gpu.handshake(); await settle();
    // A page changes while native rows are flushing; never show the old
    // page's pixels with the new page's actions.
    let release;
    const gate = new Promise((r) => { release = r; });
    flushHook = () => gate;
    dash.invalidate(); const pending = dash.render();
    await new Promise((r) => setImmediate(r));
    dash.activate(1); assert(!gpu.visible);
    release(); flushHook = null; await pending; await settle();
    assert.strictEqual(dash.paintedPage, 1); assert(gpu.visible);
    for (let i = 0; i < 12; i++) { await dash.open(i % pages.length); }
    assert.strictEqual(dash.latest.d, retainedCanvas, 'redraws reuse the same full-frame allocation');
    assert.strictEqual(dash.canvases.content.d, retainedContent, 'redraws reuse the content allocation');
    assert(dash.live.length <= 8 && fs.readdirSync(dir).length <= 8, 'PNG evidence storage remains bounded');
    const data = new CarDataReader(new SimulatedCarData()); data.setActive(true);
    try {
        await data.read();
        const populated = drawFrame(4, state, Object.assign(model(), { telemetry: data.snapshot() }), bs, null).canvas;
        const empty = drawFrame(4, state, model(), bs, null).canvas;
        assert.strictEqual(populated.w, W); assert.strictEqual(populated.h, H);
        assert(!populated.png().equals(empty.png()), 'reader snapshot populates production Data image');
        const originalModel = app._model, telemetry = data.snapshot();
        app._model = () => Object.assign(originalModel(), { telemetry });
        await dash.render(); const dataSequence = dash.sequence;
        Object.keys(telemetry.values).forEach((key) => { telemetry.values[key].sampledAt += 100; });
        await dash.render();
        assert.strictEqual(dash.sequence, dataSequence, 'sample timestamps alone do not redraw unchanged values');
        telemetry.values.rpm.status = 'stale';
        telemetry.values.rpm.lastValue = telemetry.values.rpm.value;
        telemetry.values.rpm.value = null;
        await dash.render();
        assert.strictEqual(dash.sequence, dataSequence + 1, 'freshness changes still redraw the stale label');
        app._model = originalModel;
    } finally { data.setActive(false); }
    dash.stop(); const stoppedCount = gpu.uploads.length;
    dash.invalidate(); await dash.render(); gpu.handshake();
    assert.strictEqual(gpu.uploads.length, stoppedCount);
    assert(gpu.closed && !gpu.visible && !dash.heartbeat);
    console.log('Dashboard passed: saved ID8 geometry, pixmap upload, rotary/raw focus, touch guards, native fallback, foreground lifecycle, reconnect, page races and bounded storage.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
    dash.stop(); fs.rmSync(dir, { recursive: true, force: true });
});
