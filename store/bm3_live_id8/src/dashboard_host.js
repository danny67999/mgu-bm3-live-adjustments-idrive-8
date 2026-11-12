'use strict';
const fs = require('fs');
const path = require('path');
const { pages } = require('./dashboard.js');
const { W, H, createBuffers, drawFrame, hitFrame } = require('./dashboard_frame.js');
const fonts = require('./pixel_fonts.js');
const { RenderClient, imageOp } = require('./mgu_render_client.js');
const { trace } = require('./startup_trace.js');
const { carDataView } = require('./car_data_view.js');
const focused = (e) => e && (e.focus === true || e.focus === 1 || e.value === true || e.value === 1);

// ID8 native list states hold rotary focus. The renderer draws only over
// this app's foreground area. Without a renderer the native buttons remain.
class DashboardHost {
    constructor(app, options) {
        this.app = app; this.page = 0; this.focus = null; this.signature = null;
        this.sequence = 0; this.live = []; this.stopped = false; this.active = false;
        this.nativeWritten = {}; this.navAt = {}; this.regions = []; this.paintedPage = null;
        this.captureFrames = !!(options && options.captureFrames);
        this.run = Date.now().toString(36);
        this.directory = path.resolve(__dirname, '../..', 'rhmiData/resources');
        this.gpu = options && options.client || new RenderClient('bm3_live_id8', {
            warn: (m) => trace('dashboard:renderer-warning', m)
        }, { mode: 'layer' });
        this.rendererReady = false;
        this.frame = new Uint32Array([1, 0x080d15ff].concat(Array.from(imageOp(1, 0, 0, W, H, 0))));
        this.gpu.fps(3);
        this.gpu.on('ready', (screen, info) => {
            if (this.stopped) return;
            const box = info && info.appArea;
            this.rendererReady = !!(info && info.frontGate && info.pixmap && info.pixmapSide >= W &&
                Array.isArray(info.modes) && info.modes.indexOf('layer') >= 0 && box &&
                ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(box[key])) &&
                box.x >= 0 && box.y >= 0 && box.w > 0 && box.h > 0 &&
                box.x + box.w <= screen.w && box.y + box.h <= screen.h);
            if (!this.rendererReady) {
                trace('dashboard:renderer-unsupported'); this.visibility(); return;
            }
            const scale = Math.min(box.w / W, box.h / H);
            const ox = (box.w - W * scale) / 2, oy = (box.h - H * scale) / 2;
            this.gpu.mode('layer');
            this.gpu.place({ x: box.x, y: box.y, w: box.w, h: box.h, scale, ox, oy });
            this.gpu.pixmap(1, W, H, 'rgba', 'linear');
            // Include letterboxing so a tap there cannot reach an invisible
            // native row under the drawn screen. BMW chrome stays outside.
            this.gpu.claim([{ x: -ox / scale, y: -oy / scale, w: box.w / scale, h: box.h / scale }]);
            trace('dashboard:renderer-ready', JSON.stringify({ screen, box }));
            this._publish(); this.visibility(); this.app._render();
        });
        this.gpu.on('close', () => { this.rendererReady = false; this.visibility(); });
        this.gpu.on('closed', () => this.deactivate());
        this.gpu.on('renderer-error', (error) => {
            trace('dashboard:renderer-error', error); this.rendererReady = false; this.visibility();
        });
        this.gpu.on('state', (state) => {
            trace('dashboard:renderer-state', JSON.stringify(state));
            if (!state.front) this.down = null;
        });
        this.gpu.on('touch', (phase, x, y) => {
            if (!this.active || !this.app._visible || !this.rendererReady) return;
            const action = this.hit(x, y);
            if (phase === 'down') this.down = { action, x, y };
            else if (phase === 'move' && this.down && (Math.abs(x - this.down.x) >= 20 || Math.abs(y - this.down.y) >= 20)) this.down = null;
            else if (phase === 'up') {
                const down = this.down; this.down = null;
                if (down && action && action === down.action && Math.abs(x - down.x) < 20 && Math.abs(y - down.y) < 20) this.action(action);
            }
        });
    }

    async init() {
        const rhmi = this.app.rhmiApplication;
        if (!fonts.get('label', 24) || !fonts.get('bold', 24)) throw new Error('Dashboard font atlases missing');
        if (!fs.existsSync(this.directory)) fs.mkdirSync(this.directory);
        fs.readdirSync(this.directory).filter((n) => /^bm3_dashboard_[a-z0-9]+_[0-9]+\.png(?:\.tmp)?$/.test(n)).forEach((n) => {
            const file = path.join(this.directory, n);
            if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
        });
        this.app._dashboardNav = this.app._dashboardNav || {};
        this.app._dashboardFocus = this.app._dashboardFocus || {};
        for (let page = 0; page < pages.length; page++) {
            const state = rhmi.getByName('ST_BM3_DASH_' + page);
            state.on('focus', (e) => { if (focused(e)) this.activate(page); });
            state.on('visible', (e) => {
                const visible = !!(e && (e.visible === true || e.visible === 1));
                this.app._stateVisibility('dashboard-' + page, visible);
                if (visible) this.activate(page);
                else if (page === this.page) this.deactivate();
            });
            pages[page].actions.forEach((action, index) => {
                const component = rhmi.getByName('DASH_' + page + '_' + index);
                component.on('action', () => this.app._press(action));
                this.bindFocus(component, action, page);
                this.app._actions[Number(component.getId())] = action;
            });
            ['PAGE', 'LIST'].forEach((suffix) => {
                const component = rhmi.getByName('DASH_' + page + '_' + suffix);
                const action = suffix === 'PAGE' ? 'page-next' : 'list';
                const invoke = () => this.action(action);
                component.on('action', invoke);
                this.bindFocus(component, action, page);
                this.app._dashboardNav[Number(component.getId())] = invoke;
            });
            await state.updateResources();
        }
        this.gpu.connect();
        // Register the entry before doing any raster work. The native HMI has
        // a short startup deadline, independent of the renderer connection.
        return rhmi.getByName('ST_BM3_DASH_0');
    }

    bindFocus(component, action, page) {
        const handler = (e) => {
            if (focused(e) && page === this.page && this.focus !== action) {
                this.focus = action; this.app._render();
            }
        };
        component.on('focus', handler);
        this.app._dashboardFocus[Number(component.getId())] = handler;
    }

    action(action) {
        if (this.stopped) return;
        if (Date.now() - (this.navAt[action] || 0) < 350) return;
        this.navAt[action] = Date.now();
        let work;
        if (action === 'page-next') work = this.open((this.page + 1) % pages.length);
        else if (/^page-[0-4]$/.test(action)) work = this.open(Number(action.slice(-1)));
        else if (action === 'list') { this.deactivate(); work = this.app.rhmiApplication.openState('ST_BM3_MAIN'); }
        else { this.focus = action; this.app._press(action); }
        Promise.resolve(work).catch((e) => this.app.emit('error', e));
    }

    hit(x, y) {
        return hitFrame(this.regions, x, y);
    }

    activate(page) {
        if (!Number.isInteger(page) || page < 0 || page >= pages.length || this.stopped) return;
        if (!this.active || this.page !== page) trace('dashboard:activate', 'page=' + page);
        if (this.page !== page) { this.focus = null; this.down = null; }
        this.active = true; this.page = page; this.app._bridgePage = page === 3;
        this.app._setDataPage(page === 4);
        if (page === 3) this.app._refreshBridge();
        this.visibility(); this.app._render();
    }
    deactivate() {
        if (!this.active) return;
        trace('dashboard:deactivate', 'page=' + this.page);
        this.active = false; this.down = null;
        this.app._bridgePage = false; this.app._setDataPage(false); this.visibility();
    }
    visibility() {
        const visible = !!(this.active && this.app._visible && this.rendererReady &&
            this.latest && this.paintedPage === this.page && !this.stopped);
        if (visible !== this.shown) { this.shown = visible; trace('dashboard:show', 'visible=' + visible); }
        this.gpu.show(visible);
        if (visible && !this.heartbeat) this.heartbeat = setInterval(() => {
            if (this.gpu.ready && this.gpu.visible) this.gpu.frameWords(this.frame);
        }, 1000);
        if (!visible) { this.down = null; this._clearHeartbeat(); }
    }
    _clearHeartbeat() { clearInterval(this.heartbeat); this.heartbeat = null; }
    async open(page) {
        if (!Number.isInteger(page) || page < 0 || page >= pages.length || this.stopped) return;
        // Let the target native state own focus before exposing its controls.
        this.deactivate();
        await this.app.rhmiApplication.openState('ST_BM3_DASH_' + page);
        this.activate(page);
        await this.app._render();
    }
    invalidate() { this.signature = null; this.nativeWritten = {}; }
    render() {
        this.requested = true;
        if (this.rendering) return this.rendering;
        this.rendering = Promise.resolve().then(async () => {
            while (this.requested && !this.stopped) { this.requested = false; await this.paint(); }
        }).then(() => { this.rendering = null; }, (error) => {
            this.rendering = null; this.requested = false; throw error;
        });
        return this.rendering;
    }
    _publish() {
        if (!this.rendererReady || !this.latest) return;
        this.gpu.presentPixmap(1, this.latest.d, this.frame);
    }
    async paint() {
        if (this.stopped) return;
        const pageAtStart = this.page;
        const model = this.app._model(), state = this.app._controller.snapshot(), bridge = this.app._bridge.snapshot();
        // Sample timestamps change even when the displayed numbers do not.
        // Compare the display model so each polling pass does not force a full
        // 1600x610 raster/upload solely because a timestamp advanced.
        const displayModel = Object.assign({}, model, { telemetry: carDataView(model.telemetry) });
        const signature = JSON.stringify([this.page, state, displayModel, bridge, this.focus]);
        if (signature === this.signature) return;
        const writes = [], pending = {};
        const write = (name, field, value) => {
            const key = name + '.' + field;
            if (this.nativeWritten[key] === value) return;
            pending[key] = value;
            writes.push(this.app.rhmiApplication.getByName(name).setValue(0, field, value, 'Text'));
        };
        pages.forEach((page, index) => {
            const status = index === 1 ? model.burbleStatus : index === 2 ? model.valveStatus :
                index === 3 ? model.bridgeDetail || model.bridgeStatus : index === 4 ? model.dataDetail || model.dataStatus : model.status;
            write('DASH_STATUS_' + index, 'Text', status || 'Waiting for status');
            page.actions.forEach((action, i) => {
                const button = model.buttons.find((b) => b.name === action);
                write('DASH_' + index + '_' + i, 'PrimaryText', button ? button.text + (button.enabled ? '' : ' • unavailable') : page.labels[i]);
            });
        });
        await Promise.all(writes);
        if (writes.length && this.app.rhmiApplication.flush) await this.app.rhmiApplication.flush();
        Object.assign(this.nativeWritten, pending);
        if (this.stopped) return;
        if (this.page !== pageAtStart) { this.requested = true; return; }
        const paintStart = Date.now();
        if (!this.canvases) this.canvases = createBuffers();
        const painted = drawFrame(this.page, state, model, bridge, this.focus, this.canvases), cv = painted.canvas;
        this.regions = painted.regions;
        this.paintedPage = this.page; this.latest = cv; this._publish(); this.visibility();
        if (this.captureFrames) {
            const file = path.join(this.directory, 'bm3_dashboard_' + this.run + '_' + this.sequence++ + '.png');
            fs.writeFileSync(file + '.tmp', cv.png()); fs.renameSync(file + '.tmp', file);
            this.live.push(file);
            while (this.live.length > 8) { try { fs.unlinkSync(this.live.shift()); } catch (_) {} }
        }
        const memory = process.memoryUsage();
        trace('dashboard:paint', 'page=' + this.page + ' ms=' + (Date.now() - paintStart) +
            ' rssKB=' + Math.ceil(memory.rss / 1024) + ' heapKB=' + Math.ceil(memory.heapUsed / 1024));
        this.signature = signature;
    }
    stop() { this.stopped = true; this._clearHeartbeat(); this.gpu.show(false); this.gpu.close(); }
}
module.exports = { DashboardHost };
