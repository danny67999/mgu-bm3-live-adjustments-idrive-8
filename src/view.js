'use strict';

// Rendering consumes state only and never sends a diagnostic request.
function view(snapshot, available, configError, selection) {
    const s = snapshot || {}, choice = selection || {};
    const enabled = !!(available && !s.busy && !s.transportResetRequired && !configError);
    let status = 'Identify BM3 to begin';
    if (configError) status = configError;
    else if (!s.configured) status = 'Awaiting verified BM3 marker address';
    else if (!available) status = 'Diagnostic transport unavailable';
    else if (s.busy) status = 'Working…';
    else if (s.transportResetRequired) status = s.error || 'Reconnect the diagnostic transport or restart the app before identifying again';
    else if (s.outcomeUnknown) status = s.error || 'Action outcome unknown. Check BM3 before another attempt.';
    else if (s.error) status = s.error;
    else if (s.ready) status = 'BM3 ' + s.rom + ' • current map ' + s.currentMap;
    const picked = Number.isFinite(choice.burbleTarget) ? choice.burbleTarget :
        Number.isFinite(s.burbleAggression) ? s.burbleAggression : 0;
    const target = Math.max(0, Math.min(12, Math.round(picked * 2) / 2));
    const burbleEnabled = enabled && !!s.ready && !!s.burbleReady;
    const burbleCurrent = !s.burbleReady ? 'not read' : s.burbleEnabled === false ? 'Off' :
        s.burbleCustom ? 'custom timing table' : Number.isFinite(s.burbleAggression) ? s.burbleAggression.toFixed(1) : 'unknown';
    const burbleStatus = 'Burbles: ' + burbleCurrent + ' • selected ' + target.toFixed(1) +
        ' • Off writes zeros; it does not restore the tune’s original table';
    const valveEnabled = enabled && !!s.ready && !!s.valveConfigured;
    const valveStatus = s.transportResetRequired ? 'Close and reopen the app to reconnect diagnostics.' :
        !s.valveConfigured ? 'BM3 valve adapter not configured' : !s.ready ?
        'BM3 valves • press Read to identify BM3' : s.valveAcceptedMode ?
        'Last valve command accepted: ' + s.valveAcceptedMode + ' • physical position not measured' :
        'BM3 valves • select Open, Closed or Auto';
    return {
        status, burbleStatus, burbleTarget: target, valveStatus,
        buttons: [
            { name: 'BM3_IDENTIFY', text: 'Identify BM3', enabled: enabled && !!s.configured },
            { name: 'BM3_REFRESH', text: 'Refresh current map', enabled: enabled && !!s.ready }
        ].concat([1, 2, 3, 4].map((slot) => ({
            name: 'BM3_MAP_' + slot,
            text: 'Map ' + slot + (s.ready && s.currentMap === slot ? ' • active' : ''),
            enabled: enabled && !!s.ready
        })), [
            { name: 'BM3_BURBLE_READ', text: 'Read burble settings', enabled: enabled && !!s.ready },
            { name: 'BM3_BURBLE_DOWN', text: 'Select −0.5 aggression', enabled: burbleEnabled && target > 0 },
            { name: 'BM3_BURBLE_UP', text: 'Select +0.5 aggression', enabled: burbleEnabled && target < 12 },
            { name: 'BM3_BURBLE_APPLY', text: 'Apply burble aggression ' + target.toFixed(1), enabled: burbleEnabled },
            { name: 'BM3_BURBLE_OFF', text: 'Burbles Off (zero timing table)', enabled: burbleEnabled }
        ], ['open', 'closed', 'auto'].map((mode) => ({
            name: 'BM3_VALVE_' + mode.toUpperCase(),
            text: 'BM3 valves ' + mode,
            enabled: valveEnabled
        })))
    };
}

module.exports = { view };
