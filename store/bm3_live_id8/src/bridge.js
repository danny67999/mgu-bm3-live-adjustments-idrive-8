'use strict';
// Local bridge administration only. This module never opens TCP/UDP sockets,
// authors UDS requests, configures addresses, invokes commands, or retries work.
// The Python service owns peer authorization, configuration and active sessions.
const DEFAULT_SOCKET_PATH = '/run/bm3-id8-bridge/control.sock';
const OPERATIONS = ['status', 'start', 'stop'];

function failure(message, code, requestSent, serviceResponse) {
    const error = new Error(message);
    error.code = code;
    error.requestSent = !!requestSent;
    error.serviceResponse = !!serviceResponse;
    return error;
}

function message(error) {
    return String(error && error.message || error || 'Unknown bridge error').replace(/[\x00-\x1F\x7F]+/g, ' ').slice(0, 1600);
}

class BridgeClient {
    constructor(options) {
        const opts = options || {};
        const socketPath = opts.socketPath === undefined ? DEFAULT_SOCKET_PATH : opts.socketPath;
        if (typeof socketPath !== 'string' || socketPath[0] !== '/' || socketPath.indexOf('\0') !== -1 ||
            socketPath.length > 107 || /[\r\n]/.test(socketPath)) throw new Error('Bridge control path must be an absolute local Unix socket path');
        const timeoutMs = opts.timeoutMs === undefined ? 12000 : opts.timeoutMs;
        const maxResponseBytes = opts.maxResponseBytes === undefined ? 65536 : opts.maxResponseBytes;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Bridge timeout must be 1–60000 milliseconds');
        if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 16 || maxResponseBytes > 1048576) throw new Error('Bridge response limit must be 16–1048576 bytes');
        this.options = Object.freeze({ socketPath, timeoutMs, maxResponseBytes });
    }

    request(operation) {
        if (!OPERATIONS.includes(operation)) return Promise.reject(failure('Unsupported bridge operation', 'BAD_OPERATION', false));
        // Lazy import lets the offline browser preview use BridgeController with
        // a synthetic client without including Node's native socket module.
        const net = require('net');
        const opts = this.options;
        return new Promise((resolve, reject) => {
            let socket, timer, complete = false, sent = false, size = 0;
            const chunks = [];
            const finish = (error, result) => {
                if (complete) return;
                complete = true;
                clearTimeout(timer);
                if (socket) {
                    socket.removeAllListeners();
                    socket.on('error', () => {});
                    socket.destroy();
                }
                if (error) reject(error); else resolve(result);
            };
            const fail = (text, code, serviceResponse) => finish(failure(text, code, sent, serviceResponse));
            timer = setTimeout(() => fail('Wi-Fi bridge ' + operation + ' timed out' +
                (sent && operation !== 'status' ? '; command outcome unknown' : ''), 'TIMEOUT'), opts.timeoutMs);
            try {
                socket = net.createConnection({ path: opts.socketPath });
                socket.on('connect', () => {
                    // Deliberately no force field: stopping an active diagnostic
                    // connection is never an operation exposed by this adapter.
                    sent = true;
                    socket.write(JSON.stringify({ op: operation }) + '\n');
                });
                socket.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > opts.maxResponseBytes) return fail('Bridge response exceeded the size limit', 'RESPONSE_TOO_LARGE');
                    chunks.push(chunk);
                    if (chunk.indexOf(10) < 0) return;
                    const data = Buffer.concat(chunks), newline = data.indexOf(10);
                    if (newline !== data.length - 1) return fail('Bridge service returned more than one response line', 'BAD_RESPONSE');
                    const line = data.slice(0, newline), text = line.toString('utf8');
                    if (!Buffer.from(text, 'utf8').equals(line)) return fail('Bridge response is not valid UTF-8', 'BAD_RESPONSE');
                    let envelope;
                    try { envelope = JSON.parse(text); }
                    catch (error) { return fail('Bridge service returned invalid JSON', 'BAD_RESPONSE'); }
                    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || typeof envelope.ok !== 'boolean') {
                        return fail('Bridge response has an invalid envelope', 'BAD_RESPONSE');
                    }
                    if (envelope.ok === false) {
                        if (typeof envelope.error !== 'string' || !envelope.error) return fail('Bridge rejection has no error message', 'BAD_RESPONSE');
                        return fail('Bridge service: ' + message(envelope.error), 'SERVICE_REJECTED', true);
                    }
                    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) return fail('Bridge response has no result', 'BAD_RESPONSE');
                    finish(null, envelope.result);
                });
                socket.on('error', (error) => {
                    if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
                        fail('Wi-Fi bridge service is unavailable; install or start the local service', error.code);
                    } else if (error.code === 'EACCES' || error.code === 'EPERM') {
                        fail('Wi-Fi bridge access denied; this app is not authorized for the local service', error.code);
                    } else fail('Wi-Fi bridge connection failed: ' + message(error), error.code || 'CONNECTION_ERROR');
                });
                socket.on('end', () => fail('Bridge service closed without a complete JSON response line', 'TRUNCATED_RESPONSE'));
                socket.on('close', () => { if (!complete) fail('Bridge connection closed before a response', 'CONNECTION_CLOSED'); });
            } catch (error) { fail('Cannot open local bridge control socket: ' + message(error), error.code || 'CONNECTION_ERROR'); }
        });
    }
}

function ipv4(value) {
    if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
    return value.split('.').every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

function parseStatus(result) {
    const invalid = () => { throw failure('Bridge service returned an invalid status', 'BAD_STATUS', true); };
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        !['off', 'running'].includes(result.state) || typeof result.configured !== 'boolean') return invalid();
    const source = result.profile;
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.version !== 1 ||
        typeof source.enabled !== 'boolean' || typeof source.interface !== 'string' || !/^[A-Za-z0-9_.:-]{1,15}$/.test(source.interface)) return invalid();
    if (['bind_host', 'upstream_host', 'upstream_source'].some((field) => source[field] !== null && !ipv4(source[field]))) return invalid();
    if (!Array.isArray(source.allowed_clients) || source.allowed_clients.length > 1024 || !source.allowed_clients.every(ipv4) ||
        !Array.isArray(source.protocols) || source.protocols.length < 1 || source.protocols.length > 2 ||
        !source.protocols.every((protocol) => ['hsfz', 'doip'].includes(protocol)) ||
        !Number.isInteger(source.max_connections) || source.max_connections < 1 || source.max_connections > 4) return invalid();
    const profile = Object.freeze({ version: 1, enabled: source.enabled, bind_host: source.bind_host,
        interface: source.interface, upstream_host: source.upstream_host, upstream_source: source.upstream_source,
        allowed_clients: Object.freeze(source.allowed_clients.slice()), protocols: Object.freeze(source.protocols.slice()),
        max_connections: source.max_connections });
    const configured = !!(result.configured && profile.bind_host && profile.upstream_host && profile.upstream_source && profile.allowed_clients.length);
    const enabled = result.state === 'running';
    let connections = 0;
    if (enabled) {
        const transport = result.transport;
        if (!configured || !transport || transport.running !== true || !Number.isInteger(transport.active_connections) ||
            transport.active_connections < 0 || transport.active_connections > profile.max_connections) return invalid();
        connections = transport.active_connections;
    } else if (result.transport !== null) return invalid();
    if (result.last_error !== null && typeof result.last_error !== 'string') return invalid();
    const serviceVersion = typeof result.version === 'string' ? result.version : null;
    const version = serviceVersion && /^0\.(\d+)\.\d+$/.exec(serviceVersion);
    const compatible = !!(version && Number(version[1]) >= 2);
    return { available: true, checked: true, enabled, configured, connections, profile, stateKnown: true, compatible,
        outcomeUnknown: false, error: result.last_error ? message(result.last_error) : null,
        serviceError: result.last_error ? message(result.last_error) : null,
        serviceVersion };
}

class BridgeController {
    constructor(client) {
        if (!client || typeof client.request !== 'function') throw new Error('A bridge client is required');
        this._client = client;
        this._state = { available: false, checked: false, busy: false, enabled: null, configured: null,
            connections: null, profile: null, stateKnown: false, outcomeUnknown: false,
            error: null, serviceError: null, serviceVersion: null, compatible: null };
    }

    snapshot() { return Object.freeze(Object.assign({}, this._state)); }

    _unknown(error, outcomeUnknown) {
        const mayStillBeEnabled = this._state.enabled === true || this._state.outcomeUnknown;
        Object.assign(this._state, { available: false, checked: true, enabled: null, configured: null,
            connections: null, profile: null, stateKnown: false, outcomeUnknown: !!(outcomeUnknown || mayStillBeEnabled),
            error: message(error), serviceError: null, serviceVersion: null, compatible: null });
    }

    async _status() {
        try {
            const status = parseStatus(await this._client.request('status'));
            if (this._state.outcomeUnknown && !status.compatible) {
                throw failure('The service version cannot safely reconcile command results; upgrade before clearing the uncertain state', 'SERVICE_UPGRADE_REQUIRED', false);
            }
            Object.assign(this._state, status);
        }
        catch (error) { this._unknown(error, this._state.outcomeUnknown); throw error; }
    }

    async _run(work) {
        if (this._state.busy) throw failure('Another bridge action is in progress; no action was queued', 'BUSY', false);
        this._state.busy = true;
        try { await work(); }
        catch (error) { this._state.error = message(error); throw error; }
        finally { this._state.busy = false; }
        return this.snapshot();
    }

    refresh() { return this._run(() => this._status()); }
    start() { return this._action('start'); }
    stop() { return this._action('stop'); }

    _action(operation) {
        return this._run(async () => {
            // A stale UI snapshot never authorizes a mutation. The service also
            // enforces this independently, including its non-forced stop rule.
            await this._status();
            if (!this._state.compatible) {
                throw failure('Upgrade the Wi-Fi bridge service to compatible version 0.2.0 or newer before starting or stopping it', 'SERVICE_UPGRADE_REQUIRED', false);
            }
            if (operation === 'start' && !this._state.configured) {
                throw failure('Wi-Fi bridge profile is not configured; set its hotspot, vehicle route and allowed phone first', 'NOT_CONFIGURED', false);
            }
            if (operation === 'stop' && this._state.connections > 0) {
                throw failure('A diagnostic connection is active; disconnect the client before stopping the bridge', 'ACTIVE_CONNECTION', false);
            }
            const wanted = operation === 'start';
            if (this._state.enabled === wanted) return;
            try {
                const status = parseStatus(await this._client.request(operation));
                if (status.enabled !== wanted) throw failure('Bridge action returned an unexpected state', 'BAD_STATUS', true);
                Object.assign(this._state, status);
            } catch (actionError) {
                // Never replay a start/stop. Reconcile only through status; the
                // bundled Python service serializes status behind mutations.
                const possiblySent = actionError.requestSent !== false;
                const uncertain = possiblySent && !actionError.serviceResponse;
                this._state.outcomeUnknown = uncertain;
                let followupError = null;
                try {
                    await this._status();
                    if (!this._state.compatible) {
                        followupError = failure('The service version cannot safely reconcile command results', 'SERVICE_UPGRADE_REQUIRED', false);
                        this._unknown(followupError, uncertain);
                    }
                } catch (error) { followupError = error; }
                const text = message(actionError) + (this._state.stateKnown ?
                    '; current bridge state is ' + (this._state.enabled ? 'ON' : 'OFF') :
                    '; bridge state could not be confirmed' + (uncertain ? ' and command outcome is unknown' : '') +
                        (followupError ? ': ' + message(followupError) : ''));
                const error = failure(text, actionError.code || 'ACTION_FAILED', possiblySent, actionError.serviceResponse);
                error.outcomeUnknown = this._state.outcomeUnknown;
                throw error;
            }
        });
    }
}

module.exports = { BridgeClient, BridgeController, DEFAULT_SOCKET_PATH };
