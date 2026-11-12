'use strict';

// Pure UI model. This screen controls the separate local bridge service only.
function bridgeView(snapshot, diagnosticBusy) {
    const s = snapshot || {};
    const known = s.stateKnown === true;
    const connections = Number.isInteger(s.connections) && s.connections >= 0 ? s.connections : 0;
    const idle = !s.busy && !diagnosticBusy;
    let status;
    if (s.busy) status = 'Checking Wi-Fi bridge...';
    else if (s.outcomeUnknown) status = 'Bridge state unknown - refresh status before continuing';
    else if (!s.available) status = s.error || 'Bridge service unavailable - install and authorize the companion service';
    else if (!known) status = 'Refresh to check the Wi-Fi bridge';
    else if (!s.compatible) status = 'Update the Wi-Fi bridge companion service to version 0.2.0 or newer';
    else if (!s.configured) status = 'Setup needed - configure the hotspot and phone addresses once';
    else if (s.enabled) status = 'Wi-Fi bridge ON - ' + connections + ' active connection' + (connections === 1 ? '' : 's');
    else status = 'Wi-Fi bridge OFF';
    if (s.available && s.error && !s.busy && !s.outcomeUnknown) status += ' | ' + s.error;
    const profile = s.profile || {};
    const clients = Array.isArray(profile.allowed_clients) ? profile.allowed_clients.join(', ') : '';
    let detail = 'Connect iPhone to the BMW hotspot. Keep Router blank to use cellular internet.';
    if (profile.bind_host) detail += ' Hotspot: ' + profile.bind_host + '.';
    if (clients) detail += ' Phone: ' + clients + '.';
    if (connections) detail += ' Disconnect BM3 before stopping.';
    else if (diagnosticBusy) detail += ' Wait for the current Live Adjust operation to finish.';
    return {
        status, detail, enabled: !!s.enabled, connections,
        buttons: [
            { name: 'BM3_BRIDGE_REFRESH', text: 'Refresh bridge status', enabled: idle },
            { name: 'BM3_BRIDGE_START', text: 'Start Wi-Fi bridge', enabled: !!(idle && s.available && s.compatible && known && s.configured && !s.enabled && !s.outcomeUnknown) },
            { name: 'BM3_BRIDGE_STOP', text: 'Stop Wi-Fi bridge', enabled: !!(idle && s.available && s.compatible && known && s.enabled && !connections && !s.outcomeUnknown) }
        ]
    };
}

module.exports = { bridgeView };
