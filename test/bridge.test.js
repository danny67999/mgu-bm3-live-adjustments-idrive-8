'use strict';
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { BridgeClient, BridgeController, DEFAULT_SOCKET_PATH } = require('../src/bridge');

function status(changes) {
    const result = {
        version: '0.2.0', state: 'off', configured: true,
        profile: { version: 1, enabled: false, bind_host: '192.168.40.2', interface: 'wlan_bridge',
            upstream_host: '169.254.1.1', upstream_source: '169.254.1.2', allowed_clients: ['192.168.40.3'],
            protocols: ['hsfz'], connect_timeout: 5, drain_timeout: 5, discovery_timeout: 2, max_connections: 4 },
        started_at: null, last_error: null, transport: null, development: false, vehicle_validated: false,
        app_control: { app_id: 'bm3_live_id8', available: true, uid: 30001, error: null },
    };
    Object.assign(result, changes || {});
    if (result.state === 'running' && result.transport === null) result.transport = { running: true, active_connections: 0, pending_discovery: 0, listeners: {}, counters: {} };
    return result;
}

async function serverFixture(handler, run, options) {
    // Short absolute Unix paths work on macOS as well as Linux. Every endpoint
    // below is a temporary local socket; none can contact a vehicle or network.
    const directory = fs.mkdtempSync('/tmp/bm3-bridge-');
    const socketPath = path.join(directory, 'control.sock');
    const sockets = new Set(), calls = [];
    const server = net.createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
        let input = '';
        socket.on('data', chunk => {
            input += chunk.toString();
            if (!input.endsWith('\n')) return;
            socket.removeAllListeners('data');
            assert.strictEqual(input.split('\n').length, 2);
            const request = JSON.parse(input);
            calls.push(request);
            Promise.resolve().then(() => handler(request, socket, calls)).then(reply => {
                if (reply !== undefined && !socket.destroyed) socket.end(typeof reply === 'string' || Buffer.isBuffer(reply) ? reply : JSON.stringify(reply) + '\n');
            }).catch(error => { socket.destroy(error); });
        });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const client = new BridgeClient(Object.assign({ socketPath, timeoutMs: 150 }, options || {}));
    try { await run({ client, calls, socketPath, sockets }); }
    finally {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function synthetic(handler) {
    const calls = [];
    const client = { async request(op) { calls.push(op); return handler(op, calls); } };
    return { calls, client, controller: new BridgeController(client) };
}
const tests = [];
const test = (name, run) => tests.push({ name, run });

test('constructors are silent and fixed default is a Unix socket', async () => {
    const f = synthetic(() => status());
    assert.deepStrictEqual(f.calls, []);
    assert.strictEqual(DEFAULT_SOCKET_PATH, '/run/bm3-id8-bridge/control.sock');
    assert.strictEqual(new BridgeClient().options.socketPath, DEFAULT_SOCKET_PATH);
    assert.strictEqual(f.controller.snapshot().stateKnown, false);
    assert.strictEqual(f.controller.snapshot().enabled, null);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, false);
});

test('client validates path, limits and the three allowed operations without connecting', async () => {
    for (const options of [{ socketPath: 'localhost' }, { socketPath: 'tcp://localhost:42' }, { socketPath: '/x\0y' },
        { socketPath: '/x\ny' }, { socketPath: '/' + 'x'.repeat(108) }, { timeoutMs: 0 }, { timeoutMs: Infinity },
        { maxResponseBytes: 0 }, { maxResponseBytes: 1048577 }]) assert.throws(() => new BridgeClient(options));
    const client = new BridgeClient({ socketPath: '/tmp/does-not-exist-bm3-test.sock' });
    for (const op of ['inspect', 'configure', 'force', { op: 'stop', force: true }, undefined]) {
        await assert.rejects(() => client.request(op), error => error.code === 'BAD_OPERATION' && error.requestSent === false);
    }
});

test('real Unix service accepts exactly one JSON line and receives no force field', async () => {
    await serverFixture(request => ({ ok: true, result: status({ state: request.op === 'stop' ? 'off' : 'running' }) }), async ({ client, calls }) => {
        for (const operation of ['status', 'start', 'stop']) await client.request(operation, { force: true });
        assert.deepStrictEqual(calls, [{ op: 'status' }, { op: 'start' }, { op: 'stop' }]);
    });
});

test('fragmented UTF-8 and JSON data are decoded only after the final newline', async () => {
    await serverFixture(async (request, socket) => {
        const bytes = Buffer.from(JSON.stringify({ ok: true, result: { text: 'Bridge café ✓' } }) + '\n');
        for (const byte of bytes) { socket.write(Buffer.from([byte])); await new Promise(setImmediate); }
    }, async ({ client }) => { assert.deepStrictEqual(await client.request('status'), { text: 'Bridge café ✓' }); });
});

test('missing service is descriptive and reports that no request was sent', async () => {
    const directory = fs.mkdtempSync('/tmp/bm3-missing-');
    try {
        const client = new BridgeClient({ socketPath: path.join(directory, 'missing.sock'), timeoutMs: 100 });
        await assert.rejects(() => client.request('start'), error => /service is unavailable/.test(error.message) && error.requestSent === false);
        const controller = new BridgeController(client);
        await assert.rejects(() => controller.refresh(), /unavailable/);
        assert.strictEqual(controller.snapshot().available, false);
        assert.strictEqual(controller.snapshot().stateKnown, false);
        assert.strictEqual(controller.snapshot().outcomeUnknown, false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('service rejection retains its useful explanation and is not an ambiguous transport failure', async () => {
    await serverFixture(() => ({ ok: false, error: 'A diagnostic connection is active; disconnect the client before stopping' }), async ({ client, calls }) => {
        await assert.rejects(() => client.request('stop'), error => /diagnostic connection is active/.test(error.message) && error.serviceResponse === true && error.requestSent === true);
        assert.deepStrictEqual(calls, [{ op: 'stop' }]);
    });
});

test('malformed, oversized, truncated and multiple-line replies fail closed', async () => {
    const values = ['not-json\n', '{}\n', '{"ok":true}\n', '{"ok":false}\n', '{"ok":"yes","result":{}}\n',
        '{"ok":true,"result":{}}', '{"ok":true,"result":{}}\n{}\n', Buffer.from([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xFF, 0x22, 0x7D, 0x0A])];
    for (const value of values) await serverFixture(() => value, async ({ client, calls }) => {
        await assert.rejects(() => client.request('status'), /JSON|envelope|result|error message|UTF-8|response line/);
        assert.strictEqual(calls.length, 1);
    });
    await serverFixture(() => JSON.stringify({ ok: true, result: 'x'.repeat(100) }) + '\n', async ({ client }) => {
        await assert.rejects(() => client.request('status'), error => error.code === 'RESPONSE_TOO_LARGE');
    }, { maxResponseBytes: 64 });
});

test('real Unix timeout and reset never retry a mutation', async () => {
    await serverFixture(() => undefined, async ({ client, calls }) => {
        const begin = Date.now();
        await assert.rejects(() => client.request('start'), error => error.code === 'TIMEOUT' && error.requestSent && /unknown/.test(error.message));
        assert(Date.now() - begin < 1000);
        assert.deepStrictEqual(calls, [{ op: 'start' }]);
    }, { timeoutMs: 25 });
    await serverFixture((request, socket) => { socket.destroy(); }, async ({ client, calls }) => {
        await assert.rejects(() => client.request('stop'), error => error.requestSent === true);
        assert.deepStrictEqual(calls, [{ op: 'stop' }]);
    });
});

test('real controller refresh/start/stop uses fresh status and the service state rather than stored profile.enabled', async () => {
    let running = false;
    await serverFixture(request => {
        if (request.op === 'start') running = true;
        if (request.op === 'stop') running = false;
        return { ok: true, result: status({ state: running ? 'running' : 'off' }) };
    }, async ({ client, calls }) => {
        const controller = new BridgeController(client);
        assert.strictEqual((await controller.refresh()).enabled, false);
        const on = await controller.start();
        assert.strictEqual(on.enabled, true); assert.strictEqual(on.profile.enabled, false);
        assert.strictEqual(on.available, true); assert.strictEqual(on.stateKnown, true); assert.strictEqual(on.compatible, true);
        assert(Object.isFrozen(on)); assert(Object.isFrozen(on.profile)); assert(Object.isFrozen(on.profile.allowed_clients));
        assert.throws(() => on.profile.allowed_clients.push('192.168.40.4'), TypeError);
        assert.strictEqual((await controller.stop(true)).enabled, false);
        assert.deepStrictEqual(calls, [{ op: 'status' }, { op: 'status' }, { op: 'start' }, { op: 'status' }, { op: 'stop' }]);
    });
});

test('already ON/OFF actions are status-only and unset profiles cannot start', async () => {
    const on = synthetic(() => status({ state: 'running' })); await on.controller.start(); assert.deepStrictEqual(on.calls, ['status']);
    const off = synthetic(() => status()); await off.controller.stop(); assert.deepStrictEqual(off.calls, ['status']);
    const incomplete = status({ configured: false });
    incomplete.profile.bind_host = null; incomplete.profile.upstream_host = null; incomplete.profile.upstream_source = null; incomplete.profile.allowed_clients = [];
    const f = synthetic(() => incomplete);
    await assert.rejects(() => f.controller.start(), /profile is not configured/);
    assert.deepStrictEqual(f.calls, ['status']); assert.strictEqual(f.controller.snapshot().available, true);
    assert.strictEqual(f.controller.snapshot().configured, false); assert.strictEqual(f.controller.snapshot().enabled, false);
    const partial = status(); partial.profile.upstream_host = null;
    const partialFixture = synthetic(() => partial);
    await assert.rejects(() => partialFixture.controller.start(), /profile is not configured/);
    assert.strictEqual(partialFixture.controller.snapshot().configured, false);
});

test('legacy, missing and incompatible service versions allow status but prohibit mutations', async () => {
    for (const version of ['0.1.0', undefined, null, '1.0.0', 'not-a-version', '0.2.0-beta']) {
        const f = synthetic(() => status({ version }));
        assert.strictEqual((await f.controller.refresh()).stateKnown, true);
        assert.strictEqual(f.controller.snapshot().compatible, false);
        await assert.rejects(() => f.controller.start(), /Upgrade/);
        await assert.rejects(() => f.controller.stop(), /Upgrade/);
        assert(f.calls.every(op => op === 'status'));
    }
    const current = synthetic(op => status({ version: '0.3.1', state: op === 'start' ? 'running' : 'off' }));
    assert.strictEqual((await current.controller.start()).enabled, true);
});

test('active diagnostic connections prevent stop without sending any stop or force', async () => {
    const f = synthetic(() => status({ state: 'running', transport: { running: true, active_connections: 1 } }));
    await assert.rejects(() => f.controller.stop(), /diagnostic connection is active/);
    assert.deepStrictEqual(f.calls, ['status']);
    assert.strictEqual(f.controller.snapshot().enabled, true); assert.strictEqual(f.controller.snapshot().connections, 1);
});

test('stop refusal after a client-connect race is reconciled only by status and stays ON', async () => {
    let count = 0;
    await serverFixture(request => {
        if (request.op === 'stop') return { ok: false, error: 'A diagnostic connection is active; disconnect the client before stopping' };
        count++;
        return { ok: true, result: status({ state: 'running', transport: { running: true, active_connections: count === 1 ? 0 : 1 } }) };
    }, async ({ client, calls }) => {
        const controller = new BridgeController(client);
        await assert.rejects(() => controller.stop(), /diagnostic connection is active.*state is ON/);
        assert.strictEqual(controller.snapshot().enabled, true); assert.strictEqual(controller.snapshot().stateKnown, true);
        assert.strictEqual(controller.snapshot().connections, 1);
        assert.deepStrictEqual(calls, [{ op: 'status' }, { op: 'stop' }, { op: 'status' }]);
    });
});

test('lost successful Start reply is reconciled to ON without a repeated command', async () => {
    let running = false;
    await serverFixture(request => {
        if (request.op === 'start') { running = true; return undefined; }
        return { ok: true, result: status({ state: running ? 'running' : 'off' }) };
    }, async ({ client, calls }) => {
        const controller = new BridgeController(client);
        await assert.rejects(() => controller.start(), /timed out.*state is ON/);
        assert.strictEqual(controller.snapshot().enabled, true); assert.strictEqual(controller.snapshot().stateKnown, true);
        assert.strictEqual(controller.snapshot().outcomeUnknown, false);
        assert.deepStrictEqual(calls, [{ op: 'status' }, { op: 'start' }, { op: 'status' }]);
    }, { timeoutMs: 25 });
});

test('unanswered mutation plus unavailable reconciliation remains unknown until an explicit successful status read', async () => {
    let recovered = false;
    const f = synthetic((op, calls) => {
        if (calls.length === 1) return status();
        if (recovered && op === 'status') return status({ state: 'running' });
        const error = new Error(op === 'start' ? 'start timeout' : 'service missing'); error.requestSent = op === 'start'; throw error;
    });
    await assert.rejects(() => f.controller.start(), /outcome is unknown/);
    assert.deepStrictEqual(f.calls, ['status', 'start', 'status']);
    assert.strictEqual(f.controller.snapshot().enabled, null); assert.strictEqual(f.controller.snapshot().stateKnown, false);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
    recovered = true;
    assert.strictEqual((await f.controller.refresh()).enabled, true);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, false);
    assert.deepStrictEqual(f.calls, ['status', 'start', 'status', 'status']);
});

test('lost status after known ON preserves the DME exclusion uncertainty latch', async () => {
    let fail = false;
    const f = synthetic(() => { if (fail) throw new Error('service disconnected'); return status({ state: 'running' }); });
    await f.controller.refresh(); fail = true;
    await assert.rejects(() => f.controller.refresh(), /disconnected/);
    assert.strictEqual(f.controller.snapshot().enabled, null); assert.strictEqual(f.controller.snapshot().stateKnown, false);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.controller.refresh(), /disconnected/);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
});

test('stop failing before connect preserves prior ON uncertainty if status is also lost', async () => {
    const f = synthetic((op, calls) => {
        if (calls.length === 1) return status({ state: 'running' });
        const error = new Error('local socket unavailable'); error.requestSent = false; throw error;
    });
    await assert.rejects(() => f.controller.stop(), /state could not be confirmed/);
    assert.deepStrictEqual(f.calls, ['status', 'stop', 'status']);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
});

test('malformed status clears cached state and never authorizes a command', async () => {
    const malformed = [null, {}, status({ state: 'on' }), status({ configured: 'yes' }), status({ last_error: {} }),
        status({ state: 'running', transport: { running: true, active_connections: -1 } }),
        status({ state: 'running', transport: { running: true, active_connections: 5 } }), status({ transport: {} })];
    for (const value of malformed) {
        const f = synthetic(() => value);
        await assert.rejects(() => f.controller.start(), /invalid status/);
        assert.deepStrictEqual(f.calls, ['status']); assert.strictEqual(f.controller.snapshot().stateKnown, false);
    }
});

test('action failures preserve service explanations and perform only one read-only follow-up', async () => {
    const f = synthetic(op => {
        if (op === 'start') { const error = new Error('Hotspot interface is unavailable'); error.serviceResponse = true; throw error; }
        return status({ last_error: 'Hotspot interface is unavailable' });
    });
    await assert.rejects(() => f.controller.start(), /Hotspot interface is unavailable.*state is OFF/);
    assert.deepStrictEqual(f.calls, ['status', 'start', 'status']);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, false);
    assert.strictEqual(f.controller.snapshot().serviceError, 'Hotspot interface is unavailable');
});

test('a service version downgrade during reconciliation cannot clear uncertain state', async () => {
    const f = synthetic((op, calls) => {
        if (op === 'start') throw new Error('start reply lost');
        return status({ version: calls.length === 1 ? '0.2.0' : '0.1.0' });
    });
    await assert.rejects(() => f.controller.start(), /cannot safely reconcile/);
    assert.strictEqual(f.controller.snapshot().stateKnown, false); assert.strictEqual(f.controller.snapshot().outcomeUnknown, true);
    await assert.rejects(() => f.controller.refresh(), /cannot safely reconcile/);
    assert.strictEqual(f.controller.snapshot().outcomeUnknown, true, 'manual refresh on an old service cannot clear the unresolved mutation');
});

test('busy actions are rejected without queuing or clearing the in-flight state', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = synthetic(async op => { await gate; return status({ state: op === 'start' ? 'running' : 'off' }); });
    const first = f.controller.start();
    assert.strictEqual(f.controller.snapshot().busy, true);
    await assert.rejects(() => f.controller.stop(), /no action was queued/);
    await assert.rejects(() => f.controller.refresh(), /no action was queued/);
    assert.deepStrictEqual(f.calls, ['status']);
    release();
    assert.strictEqual((await first).enabled, true);
    assert.strictEqual(f.controller.snapshot().busy, false);
    assert.deepStrictEqual(f.calls, ['status', 'start']);
});

(async () => {
    for (const item of tests) { await item.run(); console.log('ok - ' + item.name); }
    console.log(tests.length + ' bridge adapter/controller checks passed; only fake local Unix services contacted.');
})().catch(error => { console.error(error); process.exitCode = 1; });
