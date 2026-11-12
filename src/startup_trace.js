'use strict';
// App-owned, bounded lifecycle diagnostics only. Never pass protocol payloads.
const fs = require('fs');
const path = require('path');
const LIMIT = 64 * 1024;
const file = path.join(__dirname, '..', '..', 'data', 'bm3-startup.log');
function redact(value) {
    return String(value == null ? '' : value)
        .replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, '[redacted identifier]')
        .replace(/\b(?:[a-f0-9]{2}[ :]){7,}[a-f0-9]{2}\b/gi, '[redacted bytes]')
        .replace(/\b[a-f0-9]{20,}\b/gi, '[redacted bytes]');
}
function trace(stage, detail) {
    try {
        let message = detail && (detail.stack || detail.message) || detail || '';
        message = redact(message).slice(0, 4096);
        const line = new Date().toISOString() + ' ' + redact(stage).slice(0, 100) +
            (message ? ' ' + message.replace(/\r/g, '') : '') + '\n';
        const dir = path.dirname(file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, 0o700);
        let size = 0;
        try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') return; }
        if (size + Buffer.byteLength(line) > LIMIT) {
            fs.writeFileSync(file, new Date().toISOString() + ' trace:rotated (64 KiB limit)\n', { mode: 0o600 });
        }
        fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (error) { /* A log failure must not prevent the UI from opening. */ }
}
module.exports = { trace };
