'use strict';
// In-memory Python bridge service fixture. No sockets, forwarding, firewall,
// interface configuration, subprocesses or network imports are used here.
const MODES = ['normal', 'unavailable', 'unconfigured', 'active_connection'];
class SimulatedBridgeClient {
    constructor(options) {
        const o = options || {};
        this.mode = 'normal';
        this.configured = true;
        this.enabled = false;
        this.connections = 0;
        this.calls = [];
        this.delayMs = o.delayMs === undefined ? 130 : o.delayMs;
        this.startedAt = null;
    }
    setMode(mode) {
        if (!MODES.includes(mode)) throw new Error('Unknown synthetic bridge scenario');
        this.mode = mode;
        if (mode === 'unconfigured') {
            this.configured = false; this.enabled = false; this.connections = 0; this.startedAt = null;
        } else if (mode === 'active_connection') {
            this.configured = true; this.enabled = true; this.connections = 1; this.startedAt = Date.now() / 1000;
        } else if (mode === 'normal') { this.configured = true; this.connections = 0; }
    }
    status() {
        return {
            version: '0.2.0', state: this.enabled ? 'running' : 'off', configured: this.configured,
            profile: {
                version: 1, enabled: false,
                // Documentation-only addresses. They are never bound or contacted.
                bind_host: this.configured ? '192.0.2.1' : null, interface: 'wlan_bridge',
                upstream_host: this.configured ? '198.51.100.1' : null,
                upstream_source: this.configured ? '198.51.100.2' : null,
                allowed_clients: this.configured ? ['192.0.2.2'] : [], protocols: ['hsfz'],
                connect_timeout: 5, drain_timeout: 30, discovery_timeout: 2, max_connections: 4
            },
            started_at: this.startedAt, last_error: null,
            transport: this.enabled ? { running: true, active_connections: this.connections,
                pending_discovery: 0, listeners: {}, counters: {} } : null,
            development: true, vehicle_validated: false
        };
    }
    async request(op) {
        if (!['status', 'start', 'stop'].includes(op)) throw new Error('Unsupported synthetic bridge operation');
        this.calls.push(op);
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (this.mode === 'unavailable') throw new Error('Simulated bridge service unavailable');
        if (op === 'start') {
            if (!this.configured) throw new Error('Simulated bridge profile is not configured');
            this.enabled = true; this.startedAt = Date.now() / 1000;
        } else if (op === 'stop') {
            if (this.connections > 0) throw new Error('Simulated phone connection is active; disconnect before stopping');
            this.enabled = false; this.startedAt = null;
        }
        return this.status();
    }
}
module.exports = { SimulatedBridgeClient };
