'use strict';
// OFFLINE FIXTURE. No vehicle transport, sockets, discovery, or diagnostic imports.
const EventEmitter = require('events');
const MARKER_ADDRESS = '01020304';
const MAP_ADDRESS = '05060708';
const BURBLE_ENABLE_ADDRESS = '090A0B0C';
const BURBLE_TIMING_ADDRESS = '0D0E0F10';
const TARGET_ROM = 'F4C9L8R02';
const profiles = Object.freeze({
    [TARGET_ROM]: Object.freeze({ rom: TARGET_ROM, mapSwActAddr: MAP_ADDRESS, wmbaCmd: '3d',
        burbleActAddr: BURBLE_ENABLE_ADDRESS,
        liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: BURBLE_TIMING_ADDRESS, factor: 2 } } })
});
const config = Object.freeze({ identityMode: 'legacy-did', markerAddress: MARKER_ADDRESS });
const modes = ['normal', 'offline', 'wrong_rom', 'write_timeout'];
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

class SimulatedDiag extends EventEmitter {
    constructor(options) {
        super();
        const o = options || {};
        this.available = true;
        this.mode = 'normal';
        this.currentMap = 1;
        this.burbleEnabled = 1;
        this.burbleTiming = Array(24).fill(253); // synthetic aggression 1.5
        this.calls = [];
        this.delayMs = o.delayMs === undefined ? 110 : o.delayMs;
        this._generation = 0;
        this._defined = false;
    }
    setMode(mode) {
        if (!modes.includes(mode)) throw new Error('Unknown simulation mode');
        if (this.mode === mode) return;
        const prior = this.mode;
        this.mode = mode;
        // Identity changes emulate an entirely new connection. A lost-write mode
        // preserves the identified session so its next explicit switch can fail.
        if (mode === 'offline' || prior === 'offline' || mode === 'wrong_rom' || prior === 'wrong_rom') {
            this._generation++;
            this._defined = false;
            this.available = false;
            this.emit('available', false);
            if (mode !== 'offline') { this.available = true; this.emit('available', true); }
        }
        this.emit('change');
    }
    async physical(target, sid, data, timeout, accept) {
        const epoch = this._generation;
        const mode = this.mode;
        this.calls.push({ target, sid, data: Array.from(data) });
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
        if (!this.available || epoch !== this._generation) return null;
        if (target !== 0x12) throw new Error('Synthetic fixture supports only its one DME target');
        const markerBytes = Array.from(Buffer.from(MARKER_ADDRESS, 'hex'));
        const mapBytes = Array.from(Buffer.from(MAP_ADDRESS, 'hex'));
        const enableBytes = Array.from(Buffer.from(BURBLE_ENABLE_ADDRESS, 'hex'));
        const timingBytes = Array.from(Buffer.from(BURBLE_TIMING_ADDRESS, 'hex'));
        let reply;
        if (sid === 0x2C && equal(data, [2, 0xF3, 1, 0x24].concat(markerBytes, [0, 0xFF]))) {
            this._defined = true;
            reply = [0x6C, 2, 0xF3, 1];
        } else if (sid === 0x22 && this._defined && equal(data, [0xF3, 1])) {
            const rom = mode === 'wrong_rom' ? 'SYNTHETIC_UNKNOWN' : TARGET_ROM;
            reply = [0x62, 0xF3, 1].concat(Array.from(Buffer.from('BM3_R #' + rom + '\0', 'latin1')));
        } else if (sid === 0x23 && equal(data, [0x14].concat(mapBytes, [1]))) {
            reply = [0x63, this.currentMap - 1];
        } else if (sid === 0x23 && equal(data, [0x14].concat(enableBytes, [1]))) {
            reply = [0x63, this.burbleEnabled];
        } else if (sid === 0x23 && equal(data, [0x14].concat(timingBytes, [24]))) {
            reply = [0x63].concat(this.burbleTiming);
        } else if (sid === 0x3D && data.length === 7 && equal(data.slice(0, 6), [0x14].concat(enableBytes, [1])) && (data[6] === 0 || data[6] === 1)) {
            this.burbleEnabled = data[6];
            if (mode === 'write_timeout') return null;
            reply = [0x7D];
        } else if (sid === 0x3D && data.length === 30 && equal(data.slice(0, 6), [0x14].concat(timingBytes, [24]))) {
            if (!data.slice(6).every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) throw new Error('Invalid synthetic timing bytes');
            this.burbleTiming = data.slice(6);
            if (mode === 'write_timeout') return null;
            reply = [0x7D];
        } else if (sid === 0x3D && data.length === 8 && equal(data.slice(0, 6), [0x14].concat(mapBytes, [2])) && data[6] >= 0 && data[6] <= 3 && data[7] === 1) {
            this.currentMap = data[6] + 1;
            // Model the ambiguous case: state changed, but the reply was lost.
            if (mode === 'write_timeout') return null;
            reply = [0x7D];
        } else throw new Error('Unexpected command/address in synthetic fixture');
        return !accept || accept(reply) ? reply : null;
    }
}
module.exports = { SimulatedDiag, config, profiles, TARGET_ROM, MARKER_ADDRESS, MAP_ADDRESS, BURBLE_ENABLE_ADDRESS, BURBLE_TIMING_ADDRESS };
