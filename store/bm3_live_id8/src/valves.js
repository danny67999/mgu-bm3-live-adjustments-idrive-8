'use strict';
// Community BM3 Live reference sequence from MIT idrive7-apps. Official BM3
// payload equivalence and this S58's behavior remain unverified.
// See ../docs/VALVES.md and ../vendor/LICENSE.idrive7-apps. No startup traffic.
// Whole-operation serialization, transport epochs and timeouts belong to the
// Bm3Controller supplying request; this module never owns a diagnostic link.

const VALVE_ADAPTER_ID = 'bm3-flap-60fd-v1';
const EXPERIMENTAL_VALVE_ADAPTER_ID = 'bm3-live-60fd-experimental-v1';
const EXPERIMENTAL_ROM = 'F4C9L8R02';
const MODES = Object.freeze(['open', 'closed', 'auto']);
const COMMANDS = Object.freeze({
    open: Object.freeze([0x60, 0xFD, 0x03, 0x14, 0xFE]),
    closed: Object.freeze([0x60, 0xFD, 0x03, 0x23, 0x28]),
    auto: Object.freeze([0x60, 0xFD, 0x00]),
});

function validateValveMode(mode) {
    if (!MODES.includes(mode)) throw new Error('Valve mode must be open, closed, or auto');
    return mode;
}

function validateValveAdapter(verification, identity) {
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
        throw new Error('Valve control needs a configured BM3 adapter for this DME');
    }
    const keys = Object.keys(verification).sort();
    if (verification.id === EXPERIMENTAL_VALVE_ADAPTER_ID) {
        if (keys.join(',') !== 'id,rom' || verification.rom !== EXPERIMENTAL_ROM) {
            throw new Error('BM3 valve adapter requires the exact F4C9L8R02 ROM');
        }
        if (identity !== undefined && (!identity || identity.rom !== verification.rom)) {
            throw new Error('BM3 valve adapter does not match the current ROM');
        }
        return Object.freeze({ id: EXPERIMENTAL_VALVE_ADAPTER_ID, rom: EXPERIMENTAL_ROM });
    }
    if (keys.join(',') !== 'id,rom,softwareIdentityHex' || verification.id !== VALVE_ADAPTER_ID) {
        throw new Error('Unknown or incomplete verified valve adapter');
    }
    if (typeof verification.rom !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(verification.rom)) {
        throw new Error('Valve adapter needs an exact verified BM3 ROM identifier');
    }
    // These are the actual bytes after 62 F1 95, not a screenshot's SWFL label.
    const software = verification.softwareIdentityHex;
    if (typeof software !== 'string' || !/^(?:[A-Fa-f0-9]{2}){1,256}$/.test(software)) {
        throw new Error('Valve adapter needs the verified DME software identity bytes');
    }
    if (identity !== undefined && (!identity || identity.rom !== verification.rom)) {
        throw new Error('Verified valve adapter does not match the current BM3 ROM');
    }
    return Object.freeze({ id: VALVE_ADAPTER_ID, rom: verification.rom, softwareIdentityHex: software.toUpperCase() });
}

function validateValveConfiguration(config) {
    const c = config || {};
    const verifiedValveAdapter = c.verifiedValveAdapter == null ? null : validateValveAdapter(c.verifiedValveAdapter);
    const experimentalValveAdapter = c.experimentalValveAdapter == null ? null : validateValveAdapter(c.experimentalValveAdapter);
    if (verifiedValveAdapter && verifiedValveAdapter.id !== VALVE_ADAPTER_ID ||
        experimentalValveAdapter && experimentalValveAdapter.id !== EXPERIMENTAL_VALVE_ADAPTER_ID ||
        verifiedValveAdapter && experimentalValveAdapter) {
        throw new Error('Configure one BM3 valve adapter in its matching field');
    }
    if (experimentalValveAdapter && (c.identityMode !== 'direct-memory' ||
        c.markerAddress !== '807FFE50' || c.expectedRom !== EXPERIMENTAL_ROM)) {
        throw new Error('BM3 valves require the pinned direct-memory ROM identity');
    }
    return { verifiedValveAdapter, experimentalValveAdapter };
}

function responseBytes(reply, sid, prefix) {
    if (!reply || typeof reply.length !== 'number' || reply.length > 259 ||
            !Array.from(reply).every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        throw new Error('Malformed or absent valve diagnostic response');
    }
    const bytes = Array.from(reply);
    if (bytes[0] === 0x7F && bytes[1] === sid && bytes.length >= 3) {
        throw new Error('DME rejected valve request: NRC ' + bytes[2].toString(16).toUpperCase());
    }
    const wanted = [sid + 0x40].concat(prefix);
    if (bytes.length < wanted.length || !wanted.every((value, index) => bytes[index] === value)) {
        throw new Error('Unexpected valve diagnostic response');
    }
    return bytes;
}

async function applyValve(request, mode, verification, identity) {
    validateValveMode(mode);
    // Missing fresh identity must never be equivalent to a merely configured gate.
    if (!identity) throw new Error('Identify BM3 before valve control');
    const adapter = validateValveAdapter(verification, identity);
    if (typeof request !== 'function') throw new Error('A serialized diagnostic request is required');

    // Explicit experimental configuration uses the freshly read, pinned BM3
    // marker supplied by the controller. It does not claim official BM3
    // verification, or attempt the F195 identity read unsupported on this car.
    if (adapter.id === VALVE_ADAPTER_ID) {
        const software = responseBytes(await request(0x22, [0xF1, 0x95], [0xF1, 0x95]), 0x22, [0xF1, 0x95]);
        if (Buffer.from(software.slice(3)).toString('hex').toUpperCase() !== adapter.softwareIdentityHex) {
            throw new Error('DME software identity does not match the verified valve adapter');
        }
    }
    const command = COMMANDS[mode].slice();
    const prefix = command.slice(0, 3);
    responseBytes(await request(0x2F, command, prefix), 0x2F, prefix);
    // 6F acknowledges the requested control. Neither it nor a commanded duty
    // cycle proves physical movement; no validated position decoder is known.
    return Object.freeze({ requested: mode, accepted: true, confirmed: 'unknown',
        detail: mode === 'auto' ? 'DME accepted return to automatic control; physical position is not measured'
            : 'DME accepted; physical position is not measured' });
}

module.exports = { VALVE_ADAPTER_ID, EXPERIMENTAL_VALVE_ADAPTER_ID,
    validateValveMode, validateValveAdapter, validateValveConfiguration, applyValve };
