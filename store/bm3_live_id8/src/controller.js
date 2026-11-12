'use strict';
// Map and burble protocol derived from BM3 Live by ezl0l / cauliflowermossgrape.
// MIT attribution and license: ../vendor/NOTICE and LICENSE.idrive7-apps.
// No diagnostic traffic is emitted until an explicit public action is called.
const bundledProfiles = require('./profiles.js');
const { validateValveMode, validateValveAdapter, validateValveConfiguration, applyValve } = require('./valves.js');
const DME = 0x12;
const VERIFIED_ROM = 'F4C9L8R02';
const VERIFIED_MARKER_ADDRESS = '807FFE50';
const VERIFIED_PUBLIC_TAG = '#F4C9L8R02GGGJM_G87_RWD_USA_KOR_ULEV246_';

function bytes(address) {
    if (typeof address !== 'string' || !/^[A-Fa-f0-9]{8}$/.test(address)) throw new Error('A verified 32-bit marker/profile address is required');
    return Array.from(Buffer.from(address, 'hex'));
}

function markerRom(reply, profiles) {
    const text = Buffer.from(reply.slice(3)).toString('latin1');
    if (!/(?:^|[\0\s#])BM3_R(?=[\0\s#]|$)/.test(text)) throw new Error('BM3 CustomROM marker absent');
    // Whole tokens only: #ROM1 must never match #ROM10 or #ROM1_unknown.
    const tokens = [];
    const re = /#([A-Za-z0-9_]+)/g;
    let m;
    while ((m = re.exec(text))) {
        // A punctuation suffix is part of an unrecognized token, not a delimiter.
        // These conservative boundaries are tested against synthetic fixtures;
        // no physical S58 marker layout has been validated for this prototype.
        const following = text[re.lastIndex];
        if (following !== undefined && !/[#\0\s]/.test(following)) throw new Error('BM3 ROM marker is unknown or ambiguous');
        tokens.push(m[1]);
    }
    if (tokens.length !== 1 || !Object.prototype.hasOwnProperty.call(profiles, tokens[0])) {
        throw new Error('BM3 ROM marker is unknown or ambiguous');
    }
    return tokens[0];
}

function validateIdentityConfig(config) {
    const value = config || {};
    const markerAddress = value.markerAddress == null ? null : value.markerAddress;
    const identityMode = value.identityMode == null ? null : value.identityMode;
    const expectedRom = value.expectedRom == null ? null : value.expectedRom;
    if (markerAddress !== null) bytes(markerAddress);
    if (identityMode !== null && !['direct-memory', 'legacy-did', 'auto-marker'].includes(identityMode)) throw new Error('Unsupported BM3 identity mode');
    if (markerAddress !== null && identityMode === null) throw new Error('An explicit BM3 identity mode is required');
    if (expectedRom !== null && (typeof expectedRom !== 'string' || !/^[A-Za-z0-9_]+$/.test(expectedRom))) throw new Error('Invalid expected BM3 ROM');
    if (identityMode === 'direct-memory' && (markerAddress !== VERIFIED_MARKER_ADDRESS || expectedRom !== VERIFIED_ROM)) {
        throw new Error('Direct identity requires the verified G87 marker address and exact F4C9L8R02 ROM');
    }
    if (identityMode === 'auto-marker' && markerAddress !== VERIFIED_MARKER_ADDRESS) {
        throw new Error('Auto detection supports the published 807FFE50 marker location only');
    }
    return { markerAddress, identityMode, expectedRom };
}

// Development parser for the two marker layouts available to this project.
// These format rules and the ROM metadata are compatibility candidates, not
// proof that every profile has been exercised on a real vehicle.
function autoMarkerRom(payload, profiles) {
    if (!payload || payload.length !== 255 || !Array.from(payload).every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        throw new Error('Malformed auto-detection marker');
    }
    const data = Buffer.from(payload);
    if (data.slice(0, 5).toString('ascii') === 'BM3_R' && [0, 32, 35].includes(data[5])) {
        return markerRom([0x62, 0xF3, 1].concat(Array.from(data)), profiles);
    }
    if (!data.slice(0, 4).equals(Buffer.from('BM3_')) || data[101] !== 35 ||
        Array.from(data).filter((n) => n === 35).length !== 1) {
        throw new Error('Unsupported BM3 marker layout; no ROM profile selected');
    }
    const end = data.indexOf(0, 102);
    if (end < 0) throw new Error('Unterminated BM3 ROM tag');
    const tagBytes = data.slice(102, end);
    if (!Array.from(tagBytes).every((n) => n >= 48 && n <= 57 || n >= 65 && n <= 90 || n === 95)) {
        throw new Error('Invalid BM3 ROM tag characters');
    }
    const tag = tagBytes.toString('ascii');
    // Fixed-width ROM followed by five variant characters and a delimited
    // chassis/drivetrain/market suffix. Never choose by substring alone.
    const match = /^([A-Z0-9]{9})([A-Z0-9]{5}_[A-Z][0-9]{2,3}_(?:RWD|AWD|FWD)_[A-Z0-9]+(?:_[A-Z0-9]+)*_)$/.exec(tag);
    if (!match || !Object.prototype.hasOwnProperty.call(profiles, match[1])) {
        throw new Error('Unsupported BM3 ROM or variant tag; a matching profile is required');
    }
    return match[1];
}

function directMarkerRom(payload, profiles, expectedRom) {
    if (!payload || payload.length !== 255 || !Array.from(payload).every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        throw new Error('Malformed direct BM3 marker length or bytes');
    }
    const data = Buffer.from(payload), tag = Buffer.from(VERIFIED_PUBLIC_TAG, 'ascii');
    if (!data.slice(0, 4).equals(Buffer.from('BM3_', 'ascii')) || data[101] !== 0x23 ||
        Array.from(data).filter((value) => value === 0x23).length !== 1 ||
        !data.slice(101, 101 + tag.length).equals(tag) || data[101 + tag.length] !== 0) {
        throw new Error('BM3 direct marker does not match the verified G87 format');
    }
    // The remaining binary metadata is opaque. No vehicle/license bytes are
    // copied into the app or compared with a captured private binary fixture.
    if (expectedRom !== VERIFIED_ROM || !Object.prototype.hasOwnProperty.call(profiles, expectedRom)) {
        throw new Error('BM3 direct marker ROM does not match the expected supported profile');
    }
    return expectedRom;
}

class Bm3Controller {
    constructor(diag, config, profiles) {
        this._diag = diag;
        // Local configuration is immutable. There is no UI address/adapter setter.
        Object.defineProperty(this, 'config', { value: Object.freeze(Object.assign(
            validateIdentityConfig(config), validateValveConfiguration(config))), enumerable: true });
        this._profiles = Object.create(null);
        Object.entries(profiles || bundledProfiles).forEach(([key, p]) => {
            const table = p.liveTuneTables && p.liveTuneTables.KF_DZWMIN_SPORT_SOT;
            this._profiles[key] = Object.freeze({ rom: p.rom, mapSwActAddr: p.mapSwActAddr, wmbaCmd: p.wmbaCmd,
                burbleActAddr: p.burbleActAddr,
                liveTuneTables: Object.freeze({ KF_DZWMIN_SPORT_SOT: table && Object.freeze({ address: table.address, factor: table.factor }) }) });
        });
        Object.freeze(this._profiles);
        this._state = { busy: false, ready: false, rom: null, currentMap: null, error: null, outcomeUnknown: false, transportResetRequired: false,
            burbleReady: false, burbleEnabled: null, burbleAggression: null, burbleCustom: false,
            valveAcceptedMode: null, valvePosition: 'unknown' };
        this._profile = null;
        this._transportEpoch = 0;
        this._operationEpoch = 0;
        this._writeAttempted = false;
        this._sawDisconnect = false;
        // Listening does not send diagnostic traffic. A false/true transition
        // must invalidate an in-flight operation even if the next read is online.
        if (diag && typeof diag.on === 'function') diag.on('available', (available) => {
            if (!available) {
                this._transportEpoch++;
                this._sawDisconnect = true;
                this._state.transportResetRequired = true;
                this._invalidate(new Error('Diagnostic transport disconnected; identify again after reconnecting'), this._writeAttempted);
            } else if (this._sawDisconnect) {
                this._sawDisconnect = false;
                this._state.transportResetRequired = false;
            }
        });
    }

    snapshot() { return Object.freeze(Object.assign({}, this._state, { configured: !!this.config.markerAddress,
        valveConfigured: !!(this.config.verifiedValveAdapter || this.config.experimentalValveAdapter),
        valveExperimental: !!this.config.experimentalValveAdapter })); }

    invalidateForExternalSession() {
        // A phone may change the DME while forwarding is active. No request is
        // sent here; invalidate both cached values and any pending operation.
        this._transportEpoch++;
        if (this._state.busy) this._state.transportResetRequired = true;
        this._invalidate(new Error('External diagnostic session: identify BM3 again after stopping the Wi-Fi bridge'), this._writeAttempted);
        return this.snapshot();
    }

    _invalidate(error, outcomeUnknown) {
        this._profile = null;
        this._clearBurbles();
        Object.assign(this._state, { ready: false, rom: null, currentMap: null, valveAcceptedMode: null,
            error: error.message, outcomeUnknown: this._state.outcomeUnknown || !!outcomeUnknown });
    }

    async _run(work, identifying) {
        // Reject rather than queue clicks: a stale click must never switch a map later.
        if (this._state.busy) throw new Error('Another action is in progress; no action was queued');
        this._state.busy = true;
        this._operationEpoch = this._transportEpoch;
        this._writeAttempted = false;
        try {
            await work();
            // Catch a disconnect delivered between the final awaited request and
            // the completed action; readiness may only survive the same link.
            this._checkTransport();
            this._state.error = null;
            if (identifying) this._state.outcomeUnknown = false;
        }
        catch (e) {
            if (this._writeAttempted && !e.outcomeUnknown && !e.dmeRejected) {
                e = new Error('Operation outcome unknown: ' + e.message + '. Check BM3 before trying again.');
                e.outcomeUnknown = true;
            }
            this._invalidate(e, e.outcomeUnknown); throw e;
        }
        finally { this._state.busy = false; this._writeAttempted = false; }
        return this.snapshot();
    }

    _checkTransport() {
        if (this._operationEpoch !== this._transportEpoch) throw new Error('Diagnostic transport changed during the action; identify again');
        if (!this._diag || !this._diag.available) throw new Error('MGU diagnostic transport unavailable');
        if (this._state.transportResetRequired) throw new Error('Diagnostic response is uncertain; reconnect the transport or restart the app before identifying again');
    }

    async _request(sid, data, prefix) {
        this._checkTransport();
        const want = [sid + 0x40].concat(prefix || []);
        const match = (u) => u && ((u[0] === 0x7F && u[1] === sid) || want.every((b, i) => u[i] === b));
        let reply;
        try {
            reply = await this._diag.physical(DME, sid, data, 4500, match,
                { maxRetries: 0, callTimeoutMs: 4500, pendingTimeoutMs: 4500, hardTimeoutMs: 9000 });
        } catch (e) {
            if (this._operationEpoch === this._transportEpoch) this._state.transportResetRequired = true;
            throw e;
        }
        this._checkTransport();
        if (!reply || !Array.from(reply).every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
            this._state.transportResetRequired = true;
            throw new Error('Malformed or absent DME response');
        }
        if (reply[0] === 0x7F && reply[1] === sid && reply.length === 3 && reply[2] !== 0x78) {
            const meanings = { 0x11: 'service not supported', 0x12: 'subfunction not supported', 0x13: 'invalid length',
                0x21: 'busy', 0x22: 'conditions not correct', 0x31: 'request out of range', 0x33: 'security access denied',
                0x7E: 'not supported in current session', 0x7F: 'not supported in current session' };
            const error = new Error('DME rejected request: NRC ' + reply[2].toString(16).toUpperCase() +
                (meanings[reply[2]] ? ' (' + meanings[reply[2]] + ')' : ''));
            error.dmeRejected = true;
            throw error;
        }
        if (!want.every((b, i) => reply[i] === b)) {
            this._state.transportResetRequired = true;
            throw new Error('Unexpected DME response');
        }
        return reply;
    }

    async _identity() {
        const address = bytes(this.config.markerAddress);
        let rom;
        if (this.config.identityMode === 'direct-memory' || this.config.identityMode === 'auto-marker') {
            const reply = await this._request(0x23, [0x14].concat(address, [0xFF]), []);
            if (reply.length !== 256) {
                this._state.transportResetRequired = true;
                throw new Error('Malformed direct BM3 marker length; reconnect before identifying again');
            }
            rom = this.config.identityMode === 'auto-marker' ? autoMarkerRom(reply.slice(1), this._profiles) :
                directMarkerRom(reply.slice(1), this._profiles, this.config.expectedRom);
        } else if (this.config.identityMode === 'legacy-did') {
            // Explicit legacy/test mode only. The vehicle's direct mode above
            // never defines a DID, changes sessions or sends a write on Identify.
            await this._request(0x2C, [2, 0xF3, 1, 0x24].concat(address, [0, 0xFF]), [2, 0xF3, 1]);
            const reply = await this._request(0x22, [0xF3, 1], [0xF3, 1]);
            if (reply.length <= 3 || reply.length > 258) throw new Error('Malformed BM3 marker length');
            rom = markerRom(reply, this._profiles);
        } else throw new Error('An explicit BM3 identity mode is required');
        if (this.config.expectedRom !== null && rom !== this.config.expectedRom) throw new Error('BM3 identity differs from the expected ROM');
        const profile = this._profiles[rom];
        if (profile.rom !== rom || !['3d', '3e'].includes(String(profile.wmbaCmd).toLowerCase())) throw new Error('Unsupported BM3 map profile');
        bytes(profile.mapSwActAddr);
        return { rom, profile };
    }

    async _current(profile) {
        const reply = await this._request(0x23, [0x14].concat(bytes(profile.mapSwActAddr), [1]), []);
        if (reply.length !== 2) this._state.transportResetRequired = true;
        if (reply.length !== 2 || reply[1] < 0 || reply[1] > 3) throw new Error('Invalid current-map readback');
        return reply[1] + 1;
    }

    _clearBurbles() {
        Object.assign(this._state, { burbleReady: false, burbleEnabled: null, burbleAggression: null, burbleCustom: false });
    }

    _burbleProfile(profile) {
        const table = profile.liveTuneTables && profile.liveTuneTables.KF_DZWMIN_SPORT_SOT;
        if (!table || !profile.burbleActAddr) throw new Error('BM3 burble profile unavailable');
        // Validate all addresses before any read/write. The table is exactly 24
        // signed one-byte cells; only the matched profile supplies these fields.
        bytes(profile.burbleActAddr); bytes(table.address);
        const factor = table.factor;
        if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 ||
            !Number.isInteger(factor / 2) || 12 * factor > 127) throw new Error('Invalid BM3 burble factor');
        const ranges = [[parseInt(profile.mapSwActAddr, 16), 2], [parseInt(profile.burbleActAddr, 16), 1], [parseInt(table.address, 16), 24]];
        if (ranges.some(([address, size]) => address + size > 0x100000000) ||
            ranges.some(([address, size], i) => ranges.some(([other, count], j) => i !== j && address < other + count && other < address + size))) {
            throw new Error('Invalid overlapping or overflowing BM3 burble addresses');
        }
        return { enableAddress: profile.burbleActAddr, timingAddress: table.address, factor };
    }

    async _readBurbles(profile) {
        const p = this._burbleProfile(profile);
        const enable = await this._request(0x23, [0x14].concat(bytes(p.enableAddress), [1]), []);
        if (enable.length !== 2 || (enable[1] !== 0 && enable[1] !== 1)) throw new Error('Invalid burble enable readback');
        const table = await this._request(0x23, [0x14].concat(bytes(p.timingAddress), [24]), []);
        if (table.length !== 25) throw new Error('Invalid burble table readback');
        const timing = Array.from(table.slice(1)), first = timing[0], signed = first >= 128 ? first - 256 : first;
        const value = signed === 0 ? 0 : -signed / p.factor;
        const aggression = timing.every((byte) => byte === first) && signed <= 0 && value >= 0 && value <= 12 && Number.isInteger(value * 2) ? value : null;
        return { enabled: enable[1] === 1, aggression, timing };
    }

    _showBurbles(current) {
        Object.assign(this._state, { burbleReady: true, burbleEnabled: current.enabled,
            burbleAggression: current.enabled ? current.aggression : null, burbleCustom: current.enabled && current.aggression === null });
    }

    async _sameIdentity(action) {
        if (!this._state.ready || !this._profile) throw new Error('Identify BM3 before ' + action);
        const found = await this._identity();
        if (found.rom !== this._state.rom) throw new Error('BM3 identity changed; identify again');
        return found.profile;
    }

    refreshBurble() {
        return this._run(async () => {
            const profile = await this._sameIdentity('reading burbles');
            this._showBurbles(await this._readBurbles(profile));
        });
    }

    setBurble(aggression) {
        return this._changeBurbles(aggression, false);
    }

    disableBurble() {
        return this._changeBurbles(null, true);
    }

    _changeBurbles(aggression, off) {
        return this._run(async () => {
            if (!off && (typeof aggression !== 'number' || !Number.isFinite(aggression) ||
                !Number.isInteger(aggression * 2) || aggression < 0 || aggression > 12)) throw new Error('Burble aggression must be 0 to 12 in 0.5 steps');
            if (!this._state.burbleReady) throw new Error('Read burbles before applying an adjustment');
            const profile = await this._sameIdentity('adjusting burbles');
            const p = this._burbleProfile(profile);
            const current = await this._readBurbles(profile);
            const enabled = !off;
            const value = off ? 0 : Math.trunc(-Math.abs(aggression * p.factor)) & 0xFF;
            if (current.enabled === enabled && current.timing.every((byte) => byte === value)) {
                this._showBurbles(current); return;
            }
            const sid = parseInt(profile.wmbaCmd, 16), prefix = sid === 0x3E ? [0x3D] : [];
            try {
                this._writeAttempted = true;
                // Preserve upstream order: override flag first, then all 24 cells.
                // Off clears the override AND zeroes these cells; not stock restore.
                await this._request(sid, [0x14].concat(bytes(p.enableAddress), [1, enabled ? 1 : 0]), prefix);
                await this._request(sid, [0x14].concat(bytes(p.timingAddress), [24], Array(24).fill(value)), prefix);
                const actual = await this._readBurbles(profile);
                if (actual.enabled !== enabled || actual.timing.some((byte) => byte !== value)) throw new Error('Burble readback differs from the requested adjustment');
                this._showBurbles(actual);
            } catch (e) {
                const unknown = new Error('Burble outcome unknown: ' + e.message + '. Check BM3 before trying again.');
                unknown.outcomeUnknown = true;
                throw unknown;
            }
        });
    }

    setValve(mode) {
        return this._run(async () => {
            validateValveMode(mode);
            const adapter = this.config.experimentalValveAdapter || this.config.verifiedValveAdapter;
            validateValveAdapter(adapter);
            await this._sameIdentity('controlling valves');
            try {
                const result = await applyValve(async (sid, data, prefix) => {
                    if (sid === 0x2F) this._writeAttempted = true;
                    return this._request(sid, data, prefix);
                }, mode, adapter, { rom: this._state.rom });
                this._state.valveAcceptedMode = result.requested;
                // Positive acknowledgment cannot establish physical position.
                this._state.valvePosition = 'unknown';
            } catch (e) {
                if (!this._writeAttempted || e.dmeRejected) throw e;
                const unknown = new Error('Valve outcome unknown: ' + e.message + '. Verify the valve state before trying again.');
                unknown.outcomeUnknown = true;
                throw unknown;
            }
        });
    }

    identify() {
        return this._run(async () => {
            this._invalidate(new Error('Identification in progress'));
            const found = await this._identity();
            const currentMap = await this._current(found.profile);
            this._profile = found.profile;
            Object.assign(this._state, { ready: true, rom: found.rom, currentMap });
        }, true);
    }

    refresh() {
        return this._run(async () => {
            if (!this._state.ready || !this._profile) throw new Error('Identify BM3 before reading the map');
            const found = await this._identity();
            if (found.rom !== this._state.rom) throw new Error('BM3 identity changed; identify again');
            this._state.currentMap = await this._current(found.profile);
            this._clearBurbles();
        });
    }

    // Public slots are 1..4. No arbitrary address or data-writing method exists.
    select(slot) {
        return this._run(async () => {
            if (!Number.isInteger(slot) || slot < 1 || slot > 4) throw new Error('Map slot must be 1, 2, 3, or 4');
            if (!this._state.ready || !this._profile) throw new Error('Identify BM3 before switching maps');
            const found = await this._identity();
            if (found.rom !== this._state.rom) throw new Error('BM3 identity changed; identify again');
            const current = await this._current(found.profile);
            this._clearBurbles();
            if (current === slot) { this._state.currentMap = current; return; }
            const sid = parseInt(found.profile.wmbaCmd, 16);
            try {
                this._writeAttempted = true;
                await this._request(sid, [0x14].concat(bytes(found.profile.mapSwActAddr), [2, slot - 1, 1]), sid === 0x3E ? [0x3D] : []);
                const actual = await this._current(found.profile);
                if (actual !== slot) throw new Error('Map readback differs from the requested slot');
                this._state.currentMap = actual;
            } catch (e) {
                const unknown = new Error('Switch outcome unknown: ' + e.message + '. Check BM3 before trying again.');
                unknown.outcomeUnknown = true;
                throw unknown;
            }
        });
    }
}

module.exports = { Bm3Controller, markerRom, directMarkerRom, autoMarkerRom, validateIdentityConfig };
