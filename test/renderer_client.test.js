'use strict';
// Real Unix socket, protocol fixture only. Never connects to a vehicle.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { RenderClient, imageOp } = require('../src/mgu_render_client');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm3-render-wire-'));
const socketPath = path.join(dir, 'render.sock');
const pack = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length); b.writeUInt32LE(type, 0); b.writeUInt32LE(payload.length, 4); payload.copy(b, 8); return b;
};
const ints = (values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32LE(v, i * 4)); return b; };
const caps = pack(0x4d520101, ints([1, 1, 29, 0, 0, 0, 0, 0, 76, 2880, 764, 2048, 59999]));
const ready = pack(101, ints([1, 2880, 960, 3]));
const received = [], peers = [];
let readyCount = 0;
const gpu = new RenderClient('bm3_live_id8', { warn() {} }, { socket: socketPath });
const server = net.createServer((peer) => {
    const generation = peers.length; peers.push(peer); let input = Buffer.alloc(0);
    peer.on('error', () => {});
    peer.on('data', (bytes) => {
        input = Buffer.concat([input, bytes]);
        while (input.length >= 8 && input.length >= 8 + input.readUInt32LE(4)) {
            const type = input.readUInt32LE(0), len = input.readUInt32LE(4);
            const payload = Buffer.from(input.subarray(8, 8 + len)); input = input.subarray(8 + len);
            received.push({ generation, type, payload });
            if (type === 1) {
                assert(payload.toString().startsWith('bm3_live_id8\0proto=mgu-render/1'));
                // Fragment/coalesce packets like a stream, not datagrams.
                peer.write(caps.subarray(0, 5));
                setImmediate(() => peer.write(Buffer.concat([caps.subarray(5), ready])));
            }
        }
    });
});
const waitFor = async (test) => {
    const until = Date.now() + 7000;
    while (!test()) {
        if (Date.now() > until) throw new Error('Local renderer fixture timed out');
        await new Promise((r) => setTimeout(r, 10));
    }
};
gpu.on('ready', (screen, info) => {
    readyCount++;
    assert.deepStrictEqual(screen, { w: 2880, h: 960 });
    assert(info.frontGate && info.pixmap && !info.controller);
    assert.strictEqual(info.appArea.y, 76);
});
(async () => {
    const bounded = new RenderClient('test', { warn() {} });
    bounded.pixmap(1, 4, 4, 'rgba', 'linear');
    bounded.ready = bounded.native = bounded.connected = true; bounded.placement = {};
    const buffers = [], payloads = [], callbacks = [];
    bounded.sock = { write(b, callback) { buffers.push(b); payloads.push(Buffer.from(b)); callbacks.push(callback); return false; } };
    const reusable = new Uint8Array(64), ops = new Uint32Array([1, 0]);
    for (let i = 0; i < 30; i++) { reusable.fill(i); bounded.presentPixmap(1, reusable, ops); }
    assert.strictEqual(buffers.length, 1, 'backpressure keeps only one wire buffer in flight');
    assert.strictEqual(payloads[0][32], 0, 'in-flight pixels are not mutated by redraws');
    callbacks.shift()();
    assert.strictEqual(buffers.length, 2, 'only the latest pending frame is sent after completion');
    assert.strictEqual(buffers[0], buffers[1], 'completed wire buffer is reused');
    assert.strictEqual(payloads[1][32], 29, 'latest pixels replace intermediate frames');
    callbacks.shift()(); assert.strictEqual(bounded.pendingPresentation, null);
    assert.strictEqual(bounded.presentationToken, null);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    gpu.connect(); await waitFor(() => readyCount === 1);
    gpu.place({ x: 0, y: 76, w: 2880, h: 764, scale: 764 / 610, ox: 438, oy: 0 });
    gpu.pixmap(1, 1600, 610, 'rgba', 'linear');
    const pixels = new Uint8Array(1600 * 610 * 4); pixels.fill(127);
    gpu.claim([{ x: 0, y: 0, w: 1600, h: 610 }]); gpu.fps(3); gpu.show(true);
    gpu.presentPixmap(1, pixels, new Uint32Array([1, 0x080d15ff].concat(Array.from(imageOp(1, 0, 0, 1600, 610)))));
    await waitFor(() => received.some((m) => m.type === 7));
    const upload = received.find((m) => m.type === 0x4d520004).payload;
    assert.strictEqual(upload.length, 24 + pixels.length);
    assert.deepStrictEqual(Array.from(upload.subarray(0, 24)), Array.from(ints([1, 1, 0, 0, 1600, 610])));
    assert(upload.subarray(24).equals(Buffer.from(pixels)));
    const frame = received.find((m) => m.type === 7).payload;
    assert.strictEqual(frame.readUInt32LE(0), 1); assert.strictEqual(frame.readUInt32LE(8), 18);
    let touch;
    gpu.once('touch', (phase, x, y) => { touch = { phase, x, y }; });
    const t = Buffer.alloc(12); t.writeUInt32LE(3, 0); t.writeFloatLE(123.5, 4); t.writeFloatLE(550, 8);
    peers[0].write(pack(105, t)); await waitFor(() => touch);
    assert.deepStrictEqual(touch, { phase: 'up', x: 123.5, y: 550 });
    // A renderer may die in the middle of a reply. New capabilities must
    // start a fresh stream, while placement and cached pixels are replayed.
    peers[0].write(pack(104, ints([3, 0, 0, 0])).subarray(0, 6));
    await waitFor(() => gpu.inbuf.length === 6); peers[0].destroy();
    await waitFor(() => readyCount === 2);
    await waitFor(() => received.some((m) => m.generation === 1 && m.type === 0x4d520004));
    const replay = received.filter((m) => m.generation === 1);
    for (const type of [2, 3, 9, 12, 0x4d520003, 0x4d520004]) assert(replay.some((m) => m.type === type), 'replayed renderer state ' + type);
    assert.strictEqual(gpu.inbuf.length, 0);
    console.log('Renderer wire test passed: fragmented handshake, full RGBA payload, draw/touch framing, reconnect after partial reply and cached replay over a local Unix socket.');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
    gpu.close(); peers.forEach((peer) => peer.destroy()); server.close(); fs.rmSync(dir, { recursive: true, force: true });
});
