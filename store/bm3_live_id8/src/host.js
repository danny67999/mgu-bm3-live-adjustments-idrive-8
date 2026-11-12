'use strict';
// Native ID8 RHMI host. Lifecycle/widget patterns follow mgu-store (GPL-3.0-or-later).
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { Diag } = require('./diag.js');
const signals = require('./sdk_signals.js');
const { Bm3Controller, validateIdentityConfig } = require('./controller.js');
const { view } = require('./view.js');
const { validateValveConfiguration } = require('./valves.js');
const { BridgeClient, BridgeController } = require('./bridge.js');
const { bridgeView } = require('./bridge_view.js');
const { trace } = require('./startup_trace.js');
const { DashboardHost } = require('./dashboard_host.js');
const { CarDataReader } = require('./car_data.js');
const { carDataView } = require('./car_data_view.js');
const log = logging.getSDKLogger();

function loadConfig() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'vehicle.json'), 'utf8'));
        if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('expected an object');
        const identity = validateIdentityConfig(config);
        return { config: Object.assign(identity, validateValveConfiguration(config)), error: null };
    } catch (e) {
        if (e.code === 'ENOENT') return { config: { markerAddress: null }, error: null };
        return { config: { markerAddress: null }, error: 'Vehicle configuration invalid; actions disabled' };
    }
}

class Bm3App extends OnlineApp {
    constructor() {
        super();
        trace('host:super-complete');
        this._components = {};
        this._actions = {};
        this._lastPress = {};
        this._selection = {};
        this._written = {};
        this._renderRequested = false;
        this._renderPromise = null;
        this._visible = null;
        this._reportedVisibility = null;
        this._visibleStates = new Set();
        this._entryReady = false;
        this._entryOpen = false;
        this._openPromise = null;
        this._pendingOpenUuids = [];
        this._stopping = false;
        this._bridgePage = false;
        this._dataPage = false;
        this._externalSession = false;
        this._bridge = new BridgeController(new BridgeClient());
        this._diag = new Diag(signals, log);
        const settings = loadConfig();
        this._configError = settings.error;
        this._controller = new Bm3Controller(this._diag, settings.config);
        this._data = new CarDataReader(this._diag, {
            blocked: () => this._dataBlocked(), onChange: () => this._render(),
            onCycle: (result) => trace('data:cycle', JSON.stringify(result))
        });
        this.on('initialized', () => {
            trace('event:initialized', 'rhmi=' + !!this.rhmiApplication);
            this._appInitialized().catch((e) => {
                trace('ui:init-error', e);
                log.error('BM3 UI: ' + (e.stack || e.message));
            });
        });
        this.on('appStatusProxyReady', () => {
            trace('event:appStatusProxyReady');
            Promise.resolve().then(() => this.registerActive()).then(() => trace('status:active'))
                .catch((e) => { trace('status:active-error', e); log.warn('BM3 active: ' + e.message); });
        });
        this.on('error', (e) => { trace('event:error', e); log.warn('BM3 app: ' + e.message); });
        this.on('entryPointExecute', (uuid) => { trace('event:entryPointExecute'); this._open(uuid); });
        this.on('shutdown', (reason) => this._shutdown(reason));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) this._visibleStates.clear();
            this._visibility(!!(data && data.visible));
        });
    }

    async _appInitialized() {
        trace('ui:init-begin');
        // An optional diagnostic provider must never hold the UI's startup open.
        this._diag.on('available', () => {
            this._data.invalidate('Diagnostic availability changed; press Read again.');
            this._traceControls('diag:availability'); this._render();
        });
        if (!this.rhmiApplication) {
            trace('ui:no-rhmi');
            await this.initialized();
            trace('ui:initialized-without-rhmi');
            return;
        }
        const rhmi = this.rhmiApplication;
        const root = rhmi.getByName('ST_BM3_MAIN');
        trace('ui:root-resolved', 'exists=' + !!root);
        if (!root) throw new Error('ID8 main state missing');
        ['BM3_STATUS', 'BM3_BURBLE_STATUS', 'BM3_VALVE_STATUS', 'BM3_BRIDGE_STATUS', 'BM3_BRIDGE_DETAIL_STATUS',
            'BM3_DATA_STATUS', 'BM3_DATA_DETAIL_STATUS'].concat(this._model().buttons.map((button) => button.name))
            .forEach((name) => {
                const component = rhmi.getByName(name);
                if (!component) throw new Error('ID8 component missing: ' + name);
                this._components[name] = component;
                if (!name.endsWith('_STATUS')) {
                    component.on('action', () => this._press(name));
                    this._actions[Number(component.getId())] = name;
                }
            });
        trace('ui:components-bound', 'count=' + Object.keys(this._components).length);
        rhmi.on('error', (error) => trace('rhmi:error', error));
        // Some SDK versions report actions only through the application event.
        rhmi.on('userEvent', (event) => {
            const name = event && event.eventType === 'ACTION' && this._actions[Number(event.sourceId)];
            if (name) this._press(name);
            else if (event && event.eventType === 'ACTION' && this._dashboardNav && this._dashboardNav[Number(event.sourceId)]) this._dashboardNav[Number(event.sourceId)]();
            const focus = event && event.eventType === 'FOCUS' && this._dashboardFocus && this._dashboardFocus[Number(event.sourceId)];
            if (focus) focus({ value: (event.parameterMap || {})[0] });
        });
        rhmi.on('restoreHmi', () => {
            trace('rhmi:restore'); this._written = {};
            if (this._dashboard) this._dashboard.invalidate();
            this._render();
        });
        const focused = (event) => event && (event.focus === true || event.focus === 1 || event.value === true || event.value === 1);
        root.on('focus', (event) => { if (focused(event)) { this._nativePage(false, false); this._render(); } });
        const bridgeState = rhmi.getByName('ST_BM3_BRIDGE');
        trace('ui:bridge-resolved', 'exists=' + !!bridgeState);
        if (!bridgeState) throw new Error('Wi-Fi Bridge state missing');
        bridgeState.on('focus', (event) => { if (focused(event)) { this._nativePage(true, false); this._refreshBridge(); } });
        bridgeState.on('visible', (event) => {
            const visible = !!(event && (event.visible === true || event.visible === 1));
            if (visible) this._nativePage(true, false);
            this._stateVisibility('bridge', visible);
        });
        root.on('visible', (event) => {
            const visible = !!(event && (event.visible === true || event.visible === 1));
            if (visible) this._nativePage(false, false);
            this._stateVisibility('main', visible);
        });
        const dataState = rhmi.getByName('ST_BM3_DATA');
        if (!dataState) throw new Error('Vehicle Data state missing');
        dataState.on('focus', (event) => { if (focused(event)) { this._nativePage(false, true); this._render(); } });
        dataState.on('visible', (event) => {
            const visible = !!(event && (event.visible === true || event.visible === 1));
            if (visible) this._nativePage(false, true);
            this._stateVisibility('data', visible);
            this._setDataPage(visible);
        });
        // Native states need their rows/resources published before entry opens.
        // This mirrors the working Store's _setupRhmi lifecycle.
        trace('ui:resources-begin');
        await Promise.all([root, bridgeState, dataState].map((state, index) => Promise.resolve(state.updateResources())
            .then(() => trace('ui:resources-complete', 'state=' + (index + 1)))));
        const descriptions = this.appDescription && this.appDescription.application.entryPoints || [];
        const entry = this.getEntryPoints().find((candidate) =>
            descriptions.some((description) => description.uuid === candidate.getDescription().uuid));
        if (!entry) throw new Error('No BM3 entry point supplied by the app manager');
        trace('ui:entry-resolved');
        const description = entry.getDescription();
        this._entryUuid = description.uuid;
        await entry.init();
        trace('ui:entry-init-complete');
        let entryRoot = root;
        if (typeof rhmi.getResourceBundle === 'function') {
            try {
                this._dashboard = new DashboardHost(this);
                entryRoot = await this._dashboard.init();
                trace('dashboard:ready');
            } catch (e) {
                trace('dashboard:init-error', e);
                if (this._dashboard) this._dashboard.stop();
                this._dashboard = null;
            }
        }
        await rhmi.mapEntryState(description.uuid, entryRoot);
        trace('ui:entry-mapped');
        try {
            await entry.entryPoint.setText(description.textId);
            if (description.icon) await entry.entryPoint.setIcon(description.icon);
        } catch (e) { trace('ui:tile-error', e); log.warn('BM3 tile: ' + e.message); }
        await entry.setAvailability('ENABLED');
        trace('ui:entry-enabled');
        await this.initialized();
        trace('ui:initialized-complete');
        await this._render();
        trace('ui:first-render-dispatched');
        this._traceControls('ui:controls-initial');
        this._entryReady = true;
        // Proxy creation/subscriptions are not UDS traffic, but can be unavailable.
        Promise.resolve().then(() => this._diag.init()).then(() => { this._traceControls('diag:initialized'); this._render(); })
            .catch((e) => { trace('diag:init-error', e); log.warn('BM3 diagnostic transport unavailable: ' + e.message); });
        this._refreshBridge();
        // Read-only local status polling. Never auto-start or auto-stop the bridge.
        this._bridgeTimer = setInterval(() => {
            if (this._bridgePage && !this._stopping) this._refreshBridge();
        }, 2000);
        const pending = this._pendingOpenUuids.find((uuid) => uuid === this._entryUuid);
        this._pendingOpenUuids = [];
        const last = pending || this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
        trace('ui:last-entry', 'present=' + !!last);
        if (last) await this._open(last);
    }

    _visibility(visible) {
        const changed = this._visible !== visible;
        this._visible = visible;
        if (!visible) { this._entryOpen = false; this._setDataPage(false); }
        if (this._dashboard) {
            if (!visible) this._dashboard.deactivate();
            this._dashboard.visibility();
        }
        if (changed) trace('ui:visibility', 'visible=' + visible + ' initialized=' + !!(this._initialized || this.isInitialized));
        if (this._stopping || !(this._initialized || this.isInitialized) || !(this._appStatusService || this.appStatusService)) return;
        if (this._reportedVisibility === visible) return;
        this._reportedVisibility = visible;
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((promise) => Promise.resolve(promise).catch((e) => {
            if (this._reportedVisibility === visible) this._reportedVisibility = null;
            log.warn('BM3 visibility: ' + e.message);
        }));
    }

    _stateVisibility(state, visible) {
        if (visible) {
            this._visibleStates.add(state);
            clearTimeout(this._hideTimer);
            this._visibility(true);
        } else {
            this._visibleStates.delete(state);
            clearTimeout(this._hideTimer);
            this._hideTimer = setTimeout(() => {
                if (!this._visibleStates.size) this._visibility(false);
            }, 800);
        }
    }

    _open(uuid) {
        trace('ui:open-request', 'stopping=' + this._stopping + ' rhmi=' + !!this.rhmiApplication + ' uuid=' + !!uuid);
        if (this._stopping || !this.rhmiApplication || !uuid) { trace('ui:open-skipped'); return Promise.resolve(); }
        if (!this._entryReady) {
            if (this._pendingOpenUuids.length < 8 && !this._pendingOpenUuids.includes(uuid)) this._pendingOpenUuids.push(uuid);
            trace('ui:open-deferred');
            return Promise.resolve();
        }
        if (uuid !== this._entryUuid) { trace('ui:open-unmapped-entry'); return Promise.resolve(); }
        if (this._openPromise) { trace('ui:open-coalesced'); return this._openPromise; }
        if (this._entryOpen && this._visible) { trace('ui:open-already-visible'); return Promise.resolve(); }
        this._openPromise = Promise.resolve().then(async () => {
            this._visibility(true);
            await this.rhmiApplication.openEntryState(uuid);
            this._entryOpen = true;
            // Some ID8 builds do not emit state visibility/focus on entry.
            // The acknowledged mapped entry is also an authoritative activation.
            if (this._dashboard) this._dashboard.activate(0);
            await this._render();
            trace('ui:open-complete');
            this._traceControls('ui:controls-open');
        }).catch((e) => { this._entryOpen = false; trace('ui:open-error', e); log.warn('BM3 open: ' + e.message); })
            .then(() => { this._openPromise = null; });
        return this._openPromise;
    }

    _nativePage(bridge, data) {
        if (this._dashboard) this._dashboard.deactivate();
        this._bridgePage = bridge;
        this._setDataPage(data);
    }

    _setDataPage(active) {
        this._dataPage = !!active;
        this._data.setActive(active);
    }

    _dataBlocked() {
        if (this._stopping || !this._visible) return 'Vehicle data paused while the app is hidden.';
        const bridge = this._bridge.snapshot(), controller = this._controller.snapshot();
        if (!bridge.stateKnown || bridge.outcomeUnknown) return 'Check Wi-Fi bridge status before reading vehicle data.';
        if (bridge.enabled || bridge.busy) return 'Stop the Wi-Fi bridge before reading vehicle data.';
        if (controller.busy) return 'Wait for Live Adjust to finish, then press Read.';
        if (controller.transportResetRequired) return 'Reconnect diagnostics before reading vehicle data.';
        return null;
    }

    _model() {
        const bridge = this._bridge.snapshot();
        const external = bridge.enabled === true || bridge.outcomeUnknown;
        if (external && !this._externalSession) {
            this._externalSession = true;
            this._controller.invalidateForExternalSession();
            this._data.invalidate('Phone diagnostics invalidated cached data; press Read after stopping the bridge.');
        } else if (bridge.stateKnown && bridge.enabled === false) this._externalSession = false;
        const locked = bridge.enabled || bridge.busy || bridge.outcomeUnknown;
        const telemetry = this._data.snapshot(), dataModel = carDataView(telemetry);
        const model = view(this._controller.snapshot(), this._diag.available,
            locked ? 'Wi-Fi bridge is active or awaiting status. Stop it before using Live Adjust.' :
                telemetry.busy ? 'Reading vehicle data; wait or press Stop before Live Adjust.' : this._configError, this._selection);
        const bridgeModel = bridgeView(bridge, this._controller.snapshot().busy || telemetry.busy);
        model.bridgeStatus = bridgeModel.status;
        model.bridgeDetail = bridgeModel.detail;
        model.telemetry = telemetry;
        model.dataStatus = dataModel.status;
        model.dataDetail = Object.keys(dataModel.metrics).map((key) => {
            const m = dataModel.metrics[key];
            return key + ': ' + m.value + ' ' + m.unit + ' (' + m.status.toLowerCase() + ')';
        }).join(' | ');
        model.buttons = model.buttons.concat([
            { name: 'BM3_DASHBOARD_OPEN', text: 'Graphical dashboard', enabled: !!this._dashboard },
            { name: 'BM3_DATA_OPEN', text: 'Vehicle Data', enabled: true },
            { name: 'BM3_DATA_BACK', text: 'Back to Live Adjust', enabled: true },
            { name: 'BM3_BRIDGE_OPEN', text: 'Wi-Fi Bridge', enabled: true },
            { name: 'BM3_BRIDGE_BACK', text: 'Back to Live Adjust', enabled: true }
        ], bridgeModel.buttons, dataModel.buttons);
        return model;
    }

    _traceControls(stage) {
        const model = this._model();
        const snapshot = this._controller.snapshot();
        trace(stage, 'available=' + !!this._diag.available + ' configured=' + !!snapshot.configured +
            ' ready=' + !!snapshot.ready + ' transportError=' + (this._diag.error || 'none') +
            ' enabled=' + model.buttons.filter((button) => button.enabled).map((button) => button.name).join(','));
    }

    _refreshBridge() {
        if (this._stopping || this._bridge.snapshot().busy) return;
        const operation = this._bridge.refresh();
        // Background status checks must not toggle focused controls to busy and
        // back every two seconds. _press still checks the live busy guard.
        Promise.resolve(operation).catch(() => {}).then(() => this._render());
    }

    _press(name) {
        if (this._stopping) return;
        const now = Date.now();
        if (now - (this._lastPress[name] || 0) < 350) return;
        this._lastPress[name] = now;
        const button = this._model().buttons.find((item) => item.name === name);
        if (!button || !button.enabled) return;
        // Stop scheduled reads before yielding diagnostic ownership to another
        // explicit action. A pending read keeps these actions disabled above.
        if (/^BM3_(IDENTIFY|REFRESH|MAP_[1-4]|BURBLE_|VALVE_|BRIDGE_START|BRIDGE_STOP)/.test(name)) {
            this._data.stop('Live data paused for another diagnostic action.');
        }
        let operation;
        if (name === 'BM3_DASHBOARD_OPEN') {
            if (!this._dashboard) return;
            operation = this._dashboard.open(0);
        }
        else if (name === 'BM3_DATA_OPEN') {
            this._bridgePage = false; this._setDataPage(true);
            operation = this._dashboard ? this._dashboard.open(4) : this.rhmiApplication.openState('ST_BM3_DATA');
        }
        else if (name === 'BM3_DATA_BACK') {
            this._nativePage(false, false);
            operation = this.rhmiApplication.openState('ST_BM3_MAIN');
        }
        else if (name === 'BM3_DATA_READ') operation = this._data.read();
        else if (name === 'BM3_DATA_LIVE') operation = this._data.start();
        else if (name === 'BM3_DATA_STOP') this._data.stop();
        else if (name === 'BM3_BRIDGE_OPEN' || name === 'BM3_BRIDGE_BACK') {
            this._nativePage(name === 'BM3_BRIDGE_OPEN', false);
            operation = this.rhmiApplication.openState(this._bridgePage ? 'ST_BM3_BRIDGE' : 'ST_BM3_MAIN');
            if (this._bridgePage) this._refreshBridge();
        }
        else if (name === 'BM3_BRIDGE_REFRESH') operation = this._bridge.refresh();
        else if (name === 'BM3_BRIDGE_START') operation = this._bridge.start();
        else if (name === 'BM3_BRIDGE_STOP') operation = this._bridge.stop();
        else if (name === 'BM3_IDENTIFY') operation = this._controller.identify();
        else if (name === 'BM3_REFRESH') operation = this._controller.refresh();
        else if (/^BM3_MAP_[1-4]$/.test(name)) operation = this._controller.select(Number(name.slice(-1)));
        else if (name === 'BM3_BURBLE_READ') operation = this._controller.refreshBurble().then(() => {
            const value = this._controller.snapshot().burbleAggression;
            if (Number.isFinite(value)) this._selection.burbleTarget = value;
        });
        else if (name === 'BM3_BURBLE_DOWN' || name === 'BM3_BURBLE_UP') {
            this._selection.burbleTarget = this._model().burbleTarget + (name === 'BM3_BURBLE_UP' ? 0.5 : -0.5);
            this._render();
            return;
        }
        else if (name === 'BM3_BURBLE_APPLY') operation = this._controller.setBurble(this._model().burbleTarget);
        else if (name === 'BM3_BURBLE_OFF') operation = this._controller.disableBurble();
        else if (/^BM3_VALVE_(OPEN|CLOSED|AUTO)$/.test(name)) operation = this._controller.setValve(name.slice('BM3_VALVE_'.length).toLowerCase());
        else return;
        this._render();
        Promise.resolve(operation).catch((e) => {
            trace('action:error', name + ': ' + e.message);
            log.warn('BM3 action: ' + e.message);
        }).then(() => this._render());
    }

    _render() {
        if (this._stopping || !this._components.BM3_STATUS) return Promise.resolve();
        this._renderRequested = true;
        if (this._renderPromise) return this._renderPromise;
        this._renderPromise = Promise.resolve().then(async () => {
            while (this._renderRequested && !this._stopping) {
                this._renderRequested = false;
                const model = this._model(), writes = [];
                const changed = (name, field, value) => {
                    const key = name + '.' + field;
                    if (this._written[key] === value) return;
                    this._written[key] = value;
                    const component = this._components[name];
                    writes.push(component.setValue(0, field, value, 'Text'));
                };
                changed('BM3_STATUS', 'Text', model.status);
                changed('BM3_BURBLE_STATUS', 'Text', model.burbleStatus);
                changed('BM3_VALVE_STATUS', 'Text', model.valveStatus);
                changed('BM3_BRIDGE_STATUS', 'Text', model.bridgeStatus);
                changed('BM3_BRIDGE_DETAIL_STATUS', 'Text', model.bridgeDetail);
                changed('BM3_DATA_STATUS', 'Text', model.dataStatus);
                changed('BM3_DATA_DETAIL_STATUS', 'Text', model.dataDetail);
                model.buttons.forEach((button) => {
                    // Focusability is constant in the native resources. A row
                    // remains reachable even when its guarded action is denied.
                    changed(button.name, 'PrimaryText', button.text + (button.enabled ? '' : ' • unavailable'));
                });
                await Promise.all(writes);
                if (this._dashboard) {
                    try { await this._dashboard.render(); }
                    catch (e) { trace('dashboard:render-error', e); }
                }
                if (writes.length && this.rhmiApplication.flush) {
                    try { await this.rhmiApplication.flush(); }
                    catch (error) { trace('ui:flush-error', error); throw error; }
                }
            }
        }).catch((e) => {
            this._written = {};
            this._renderRequested = false;
            trace('ui:render-error', e);
            log.warn('BM3 render: ' + e.message);
        }).then(() => {
            this._renderPromise = null;
            if (this._renderRequested && !this._stopping) return this._render();
        });
        return this._renderPromise;
    }

    _shutdown(reason) {
        trace('event:shutdown', reason && typeof reason === 'object' ? JSON.stringify(reason) : String(reason == null ? 'unspecified' : reason));
        if (this._stopping) return;
        this._stopping = true;
        this._data.setActive(false);
        this._data.stop();
        if (this._dashboard) this._dashboard.stop();
        clearInterval(this._bridgeTimer);
        clearTimeout(this._hideTimer);
        // Do not automatically retry a request or restore a map during shutdown.
        Promise.resolve().then(() => this._diag.p && this._diag.p.shutdown && this._diag.p.shutdown())
            .catch(() => {}).then(() => this.destroyBundles()).catch(() => {}).then(() => process.exit(0));
    }
}

if (require.main === module) {
    const app = new Bm3App();
    app.start().catch((e) => log.error('BM3 start: ' + e.message));
}

module.exports = { Bm3App, loadConfig };
