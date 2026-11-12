'use strict';
// Read-only SAE Mode 01 channels. No BM3 RAM addresses, session changes,
// tester-present, writes, or traffic merely from constructing/rendering this.
const DME = 0x12;
const MODE = 0x01;
const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
const word = (a) => a[0] * 256 + a[1];
const percent = (a) => a[0] * 100 / 255;
const temperature = (a) => a[0] - 40;
const channels = [
    { key: 'ethanol', pid: 0x52, bytes: 1, unit: '%', decode: percent },
    { key: 'rpm', pid: 0x0C, bytes: 2, unit: 'rpm', decode: (a) => word(a) / 4 },
    { key: 'speed', pid: 0x0D, bytes: 1, unit: 'km/h', decode: (a) => a[0] },
    { key: 'coolant', pid: 0x05, bytes: 1, unit: 'C', decode: temperature },
    { key: 'intake', pid: 0x0F, bytes: 1, unit: 'C', decode: temperature },
    { key: 'manifold', pid: 0x0B, bytes: 1, unit: 'kPa abs', decode: (a) => a[0] },
    { key: 'barometric', pid: 0x33, bytes: 1, unit: 'kPa abs', decode: (a) => a[0] },
    { key: 'voltage', pid: 0x42, bytes: 2, unit: 'V', decode: (a) => word(a) / 1000 },
    { key: 'oil', pid: 0x5C, bytes: 1, unit: 'C', decode: temperature },
    { key: 'fuel', pid: 0x2F, bytes: 1, unit: '%', decode: percent }
];
const fastKeys = ['rpm', 'manifold', 'speed'];
const fastChannels = fastKeys.map((key) => channels.find((c) => c.key === key));
// Atmospheric pressure is needed before the first gauge-boost calculation.
const slowChannels = ['barometric', 'ethanol', 'coolant', 'intake', 'voltage', 'oil', 'fuel']
    .map((key) => channels.find((c) => c.key === key));

function supports(bitmap, base, pid) {
    const bit = pid - base - 1;
    return bit >= 0 && bit < 32 && !!(bitmap[Math.floor(bit / 8)] & (1 << (7 - bit % 8)));
}

class Cancelled extends Error {}

class CarDataReader {
    constructor(diag, options) {
        const opts = options || {};
        this.diag = diag;
        this.now = opts.now || Date.now;
        this.blocked = opts.blocked || (() => null);
        this.changed = opts.onChange || (() => {});
        this.onCycle = opts.onCycle || (() => {});
        this.setTimer = opts.setTimer || setTimeout;
        this.clearTimer = opts.clearTimer || clearTimeout;
        this.intervalMs = opts.intervalMs || 500;
        this.staleMs = opts.staleMs || 5000;
        this.active = false;
        this.busy = false;
        this.live = false;
        this._epoch = 0;
        this._supported = null;
        this._values = {};
        this._invalid = false;
        this.status = 'Read checks which data this DME exposes.';
    }

    reason() {
        if (!this.active) return 'Open the Data page to read vehicle data.';
        if (!this.diag.available) return 'Diagnostic connection unavailable.';
        return this.blocked() || null;
    }

    snapshot() {
        const reason = this.reason(), now = this.now(), values = {};
        channels.concat([{ key: 'boost', unit: 'psi' }]).forEach((channel) => {
            const sample = this._values[channel.key];
            if (!sample) {
                values[channel.key] = { status: 'unread', value: null, unit: channel.unit, sampledAt: null };
            } else {
                const age = now - sample.sampledAt;
                const valid = !reason && !this._invalid && Number.isFinite(sample.value) && age >= 0 && age <= this.staleMs;
                values[channel.key] = Object.assign({}, sample, {
                    status: sample.supported === false ? 'unsupported' : valid ? 'valid' : 'stale',
                    // A separate lastValue may be shown only with a stale label.
                    // Disconnects, external sessions and failed reads clear it.
                    lastValue: !reason && !this._invalid && sample.supported && age >= 0 &&
                        Number.isFinite(sample.value) && !valid ? sample.value : null,
                    value: sample.supported === false || !valid ? null : sample.value
                });
            }
        });
        // Keep the controls stable between live passes. Stop releases ownership
        // once the outstanding request has actually settled.
        return { busy: this.busy || this.live, live: this.live, active: this.active, blocked: reason,
            status: reason || this.status, values };
    }

    setActive(active) {
        if (this.active === !!active) return;
        this.active = !!active;
        if (!active) {
            this.clearTimer(this._expiryTimer);
            this.stop('Live reads stopped; press Read or Live when you return.');
        }
    }

    stop(message) {
        this.live = false;
        this._epoch++;
        this.clearTimer(this._timer);
        this._timer = null;
        this.status = message || 'Reads stopped. Older readings are labelled LAST SAMPLE.';
        this.changed();
    }

    invalidate(message) {
        this._supported = null;
        this._invalid = true;
        this.clearTimer(this._expiryTimer);
        this.stop(message || 'Connection changed; press Read to check data again.');
    }

    read() { return this._read(false); }
    start() { return this._read(true); }

    _scheduleExpiry() {
        this.clearTimer(this._expiryTimer);
        if (!this.active) return;
        const now = this.now();
        const expiries = Object.keys(this._values).map((key) => this._values[key])
            .filter((s) => s.supported && Number.isFinite(s.value) && s.sampledAt + this.staleMs >= now)
            .map((s) => s.sampledAt + this.staleMs + 1 - now);
        if (!expiries.length) return;
        this._expiryTimer = this.setTimer(() => {
            this.changed(); this._scheduleExpiry();
        }, Math.max(1000, Math.min.apply(null, expiries)));
    }

    _check(epoch) {
        if (epoch !== this._epoch || this.reason()) throw new Cancelled();
    }

    async _pid(pid, size, epoch) {
        this._check(epoch);
        // The shared transport filters physical source ECU. This accept function
        // also requires the requested service and PID; unrelated frames cannot
        // supply data, and pending responses remain bounded by hardTimeoutMs.
        const reply = await this.diag.physical(DME, MODE, [pid], 1800,
            (r) => r[0] === 0x41 && r[1] === pid || r[0] === 0x7F && r[1] === MODE,
            { maxRetries: 0, callTimeoutMs: 2200, pendingTimeoutMs: 1800, hardTimeoutMs: 4500 });
        this._check(epoch);
        if (!reply) throw new Error('PID ' + hex(pid) + ' did not respond.');
        if (reply[0] === 0x7F && reply[1] === MODE) throw new Error('PID ' + hex(pid) + ' rejected (NRC ' + hex(reply[2] || 0) + ').');
        const data = Array.prototype.slice.call(reply);
        if (data.length !== size + 2 || data[0] !== 0x41 || data[1] !== pid ||
            !data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
            throw new Error('PID ' + hex(pid) + ' returned invalid data.');
        }
        return data.slice(2);
    }

    async _discover(epoch) {
        const supported = {};
        for (let base = 0; base <= 0x40; base += 0x20) {
            const bitmap = await this._pid(base, 4, epoch);
            channels.forEach((c) => { if (supports(bitmap, base, c.pid)) supported[c.pid] = true; });
            if (!supports(bitmap, base, base + 32)) break;
        }
        this._supported = supported;
    }

    _boost() {
        const map = this._values.manifold, baro = this._values.barometric;
        const fresh = (s) => s && s.supported && Number.isFinite(s.value) &&
            this.now() - s.sampledAt >= 0 && this.now() - s.sampledAt <= this.staleMs;
        this._values.boost = {
            supported: !!(this._supported[0x0B] && this._supported[0x33]), unit: 'psi',
            value: fresh(map) && fresh(baro) ? (map.value - baro.value) / 6.894757293 : null,
            sampledAt: map && baro ? Math.min(map.sampledAt, baro.sampledAt) : this.now(),
            // Standard MAP saturates at 255 kPa absolute, below some tuned peaks.
            lowerBound: !!(map && map.value === 255)
        };
    }

    _livePlan() {
        // Read fast channels every pass. Rotate two slower readings, oldest
        // first, instead of making RPM wait behind a complete nine-PID sweep.
        const slow = slowChannels.filter((c) => this._supported[c.pid]).map((c, index) => {
            const sample = this._values[c.key];
            return { channel: c, index, at: sample && !this._invalid ? sample.sampledAt : -Infinity };
        }).sort((a, b) => a.at === b.at ? a.index - b.index : a.at - b.at)
            .slice(0, 2).map((item) => item.channel);
        const fast = fastChannels.filter((c) => this._supported[c.pid]);
        // Publish boost on the first pass too; it cannot use an absent barometer.
        if (!this._values.barometric && slow.some((c) => c.key === 'barometric')) {
            fast.push(slow.shift());
        }
        return { fast, slow };
    }

    async _read(live, scheduled) {
        if (this.busy) return false;
        const reason = this.reason();
        if (reason) { this.stop(reason); return false; }
        this.clearTimer(this._timer);
        this._timer = null;
        this.live = live;
        this.busy = true;
        const epoch = ++this._epoch;
        const started = this.now();
        if (!scheduled) {
            this.status = this._supported ? 'Reading advertised vehicle channels...' : 'Checking supported Mode 01 channels...';
            this.changed();
        }
        let success = false;
        const sampled = [];
        let firstUpdateMs = null;
        try {
            if (!this._supported) await this._discover(epoch);
            if (this._invalid) this._values = {};
            channels.forEach((channel) => {
                if (!this._supported[channel.pid]) {
                    this._values[channel.key] = { supported: false, value: null, unit: channel.unit, sampledAt: this.now() };
                }
            });
            const plan = live ? this._livePlan() : {
                fast: fastChannels.concat(slowChannels.slice(0, 1)).filter((c) => this._supported[c.pid]),
                slow: slowChannels.slice(1).filter((c) => this._supported[c.pid])
            };
            this._invalid = false;
            const count = channels.filter((c) => this._supported[c.pid]).length;
            if (!count) this.live = false;
            this.status = count ? (this.live ? 'LIVE | ' : 'Sample read | ') + count + ' channels.' :
                'No dashboard channels advertised by this DME.';
            for (const group of [plan.fast, plan.slow]) {
                for (const channel of group) {
                    const data = await this._pid(channel.pid, channel.bytes, epoch);
                    this._values[channel.key] = { supported: true, value: channel.decode(data), unit: channel.unit, sampledAt: this.now() };
                    sampled.push(channel.key);
                }
                this._check(epoch);
                this._boost();
                this._scheduleExpiry();
                if (group.length) {
                    if (firstUpdateMs === null) firstUpdateMs = this.now() - started;
                    this.changed();
                }
            }
            success = true;
        } catch (error) {
            this.live = false;
            if (error instanceof Cancelled) {
                if (epoch === this._epoch) this.status = this.reason() || 'Read cancelled; press Read to try again.';
            } else {
                this._supported = null;
                this._invalid = true;
                this.clearTimer(this._expiryTimer);
                this.status = error.message + ' Reads stopped; press Read to retry.';
            }
        }
        this.busy = false;
        try { this.onCycle({ success, elapsedMs: this.now() - started, live: this.live,
            firstUpdateMs, sampledChannels: sampled,
            ethanolSupported: this._supported ? !!this._supported[0x52] : null,
            channels: this._supported ? channels.filter((c) => this._supported[c.pid]).map((c) => c.key) : [],
            error: success ? null : this.status }); } catch (_) {}
        if (!this.live || !success) this.changed();
        if (this.live && epoch === this._epoch) {
            this._timer = this.setTimer(() => { this._timer = null; this._read(true, true); },
                Math.max(50, this.intervalMs - (this.now() - started)));
        }
        return success;
    }
}

module.exports = { CarDataReader, channels, supports };
