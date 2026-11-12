'use strict';
const { Canvas } = require('./pixel_canvas.js');
const { carDataView } = require('./car_data_view.js');
const pages = [
    { title: 'MAPS', actions: ['BM3_IDENTIFY', 'BM3_MAP_1', 'BM3_MAP_2', 'BM3_MAP_3', 'BM3_MAP_4'], labels: ['Read', 'Map 1', 'Map 2', 'Map 3', 'Map 4'] },
    { title: 'BURBLES', actions: ['BM3_BURBLE_READ', 'BM3_BURBLE_DOWN', 'BM3_BURBLE_UP', 'BM3_BURBLE_APPLY', 'BM3_BURBLE_OFF'], labels: ['Read', 'Less', 'More', 'Apply', 'Off'] },
    { title: 'VALVES', actions: ['BM3_IDENTIFY', 'BM3_VALVE_OPEN', 'BM3_VALVE_CLOSED', 'BM3_VALVE_AUTO'], labels: ['Read', 'Open', 'Closed', 'Auto'] },
    { title: 'WI-FI BRIDGE', actions: ['BM3_BRIDGE_REFRESH', 'BM3_BRIDGE_START', 'BM3_BRIDGE_STOP'], labels: ['Refresh', 'Start', 'Stop'] },
    { title: 'DATA', actions: ['BM3_DATA_READ', 'BM3_DATA_LIVE', 'BM3_DATA_STOP'], labels: ['Read', 'Live', 'Stop'] }
];
const colors = { bg: '#080d15', panel: '#141f2d', edge: '#26394e', text: '#f2f6fc', dim: '#9aadc3', blue: '#76c9ff', red: '#ed344d', amber: '#ffbb60' };
function draw(page, state, model, bridge, bridgeModel, focus, canvas) {
    const c = colors, cv = (canvas || new Canvas(1600, 520)).clear(c.bg);
    const text = (value, x, y, size, color) => cv.text(String(value).replace(/•/g, '|'), x, y, size || 24, color || c.text, { font: 'bold' });
    const fit = (value, x, y, width, size, color) => {
        let s = String(value).replace(/•/g, '|');
        while (s.length && cv.textWidth(s, size) > width) s = s.slice(0, -1);
        text(s, x, y, size, color);
    };
    text('BM3', 32, 48, 32); text('LIVE ADJUST', 117, 47, 22, c.dim);
    pages.forEach((p, i) => {
        const x = 452 + i * 224;
        if (i === page) cv.roundRect(x - 16, 12, 216, 49, 10, c.panel);
        text(p.title, x, 45, 21, i === page ? c.blue : c.dim);
    });
    const card = (x, y, w, h, selected) => {
        cv.roundRect(x, y, w, h, 18, selected ? '#16344b' : c.panel);
        cv.strokeRoundRect(x, y, w, h, 18, selected ? 3 : 1, selected ? c.blue : c.edge);
    };
    if (page === 0) {
        text('MAP SWITCHING', 32, 112, 28);
        [1, 2, 3, 4].forEach((slot, i) => {
            const x = 32 + i * 392, active = state.ready && state.currentMap === slot;
            card(x, 143, 368, 245, focus === 'BM3_MAP_' + slot);
            text('MAP', x + 27, 186, 22, c.dim); text(slot, x + 27, 296, 100);
            text(active ? 'ACTIVE' : state.ready ? 'AVAILABLE' : 'READ REQUIRED', x + 27, 354, 22, active ? c.blue : c.dim);
            if (active) cv.roundRect(x + 265, 164, 75, 7, 3, c.red);
        });
    } else if (page === 1) {
        text('EXHAUST BURBLES', 32, 112, 28);
        card(32, 143, 488, 245, focus === 'BM3_BURBLE_READ');
        text('LAST READ', 60, 185, 22, c.dim);
        const value = !state.burbleReady ? '--' : !state.burbleEnabled ? 'OFF' : state.burbleCustom ? 'CUSTOM' : state.burbleAggression.toFixed(1);
        text(value, 60, 290, value === 'CUSTOM' ? 54 : 86);
        card(544, 143, 1024, 245, /^BM3_BURBLE_(UP|DOWN|APPLY)$/.test(focus || ''));
        text('SELECTED AGGRESSION', 575, 185, 22, c.dim); text(model.burbleTarget.toFixed(1), 575, 290, 86, c.blue);
        for (let i = 0; i < 25; i++) cv.roundRect(835 + i * 27, 225, 18, 65, 5, i <= model.burbleTarget * 2 ? c.blue : c.edge);
        text('0 - 12  |  0.5 steps  |  Apply to confirm', 575, 350, 23, c.dim);
    } else if (page === 2) {
        text('EXHAUST VALVES', 32, 112, 28);
        
        ['OPEN', 'CLOSED', 'AUTO'].forEach((mode, i) => {
            const x = 32 + i * 520; card(x, 143, 496, 245, focus === 'BM3_VALVE_' + mode);
            const accepted = state.ready && state.valveAcceptedMode === mode.toLowerCase();
            text(mode, x + 30, 237, 49);
            text(accepted ? 'Last command accepted' : !state.valveConfigured ? 'Not configured' :
                !state.ready ? 'Press Read first' : 'BM3 Live command', x + 30, 310, 23, accepted ? c.blue : c.dim);
            if (accepted) text('Position not measured', x + 30, 350, 20, c.dim);
        });
    } else if (page === 3) {
        text('PHONE DIAGNOSTICS', 32, 112, 28);
        card(32, 143, 488, 245, false); text('WI-FI BRIDGE', 60, 185, 22, c.dim);
        text(bridge.stateKnown ? bridge.enabled ? 'ON' : 'OFF' : '--', 60, 290, 86, bridge.enabled ? c.blue : c.text);
        text((bridge.connections == null ? '--' : bridge.connections) + ' diagnostic connections', 60, 354, 23, c.dim);
        card(544, 143, 1024, 245, false); text('BMW WI-FI + CELLULAR', 575, 190, 28);
        text('Join BMW Wi-Fi, then open the official BM3 app.', 575, 246, 25, c.dim);
        text('Keep the iPhone Router field blank.', 575, 292, 25, c.blue);
        text('Wi-Fi devices are not diagnostic connections.', 575, 350, 23, c.dim);
    } else if (page === 4) {
        const data = carDataView(model.telemetry), m = data.metrics, telemetry = model.telemetry || {};
        text('VEHICLE DATA', 32, 112, 28);
        text(telemetry.busy ? 'READING' : telemetry.live ? 'LIVE' : 'READ ONLY', 1376, 110, 20, c.blue);
        const tiles = [
            ['BOOST', m.boost], ['OIL TEMP', m.oil], ['COOLANT', m.coolant], ['INTAKE', m.intake],
            ['VOLTAGE', m.voltage], ['ENGINE RPM', m.rpm], ['SPEED', m.speed], ['FUEL LEVEL', m.fuel]
        ];
        tiles.forEach((tile, i) => {
            const x = 32 + i % 4 * 392, y = 143 + Math.floor(i / 4) * 129, value = tile[1];
            card(x, y, 376, 116, false);
            text(tile[0], x + 18, y + 29, 18, c.dim);
            text(value.value, x + 18, y + 75, 36, value.fresh ? c.text : c.dim);
            const unit = value.unit === 'C' ? 'deg C' : value.unit;
            text(unit, x + 163, y + 75, 16, c.dim);
            text(value.status, x + 18, y + 101, 14, c.dim);
        });
    }
    cv.roundRect(32, 412, 1536, 84, 12, '#101b28');
    fit(page === 3 ? bridgeModel.status : page === 4 ? carDataView(model.telemetry).status : model.status, 55, 447, 1488, 23, c.text);
    fit(page === 1 ? 'Off zeros the timing table; it does not restore the tune. Select changes nothing until Apply.' :
        page === 2 ? model.valveStatus :
        page === 4 ? 'Live refreshes while this page is open. Older readings stay dimmed as LAST SAMPLE.' :
        'Tap the tabs or action buttons. Use the wheel to select an action; Pages cycles the screens.', 55, 479, 1488, 20, c.dim);
    return cv;
}
module.exports = { pages, draw };
