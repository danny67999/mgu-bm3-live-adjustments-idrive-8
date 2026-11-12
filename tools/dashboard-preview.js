'use strict';
// Loopback-only simulation. No vehicle transport is imported by this preview.
const http = require('http');
const { pages } = require('../src/dashboard');
const { drawFrame } = require('../src/dashboard_frame');
const { view } = require('../src/view');
const { Bm3Controller } = require('../src/controller');
const { BridgeController } = require('../src/bridge');
const { bridgeView } = require('../src/bridge_view');
const { SimulatedDiag, config, profiles } = require('../emulator/simulated_diag');
const { SimulatedBridgeClient } = require('../emulator/simulated_bridge');
const { SimulatedCarData } = require('../emulator/simulated_car_data');
const { CarDataReader } = require('../src/car_data');
const { carDataView } = require('../src/car_data_view');
const controller = new Bm3Controller(new SimulatedDiag(), config, profiles);
const bridge = new BridgeController(new SimulatedBridgeClient());
const selection = {};
let page = 0, focus = null, external = false, busy = false;
const data = new CarDataReader(new SimulatedCarData(), { blocked: () => {
    const b = bridge.snapshot();
    return b.enabled || !b.stateKnown || b.busy ? 'Stop the simulated bridge before reading data.' :
        controller.snapshot().busy ? 'Wait for the simulated controller.' : null;
} });
function model() {
    const b = bridge.snapshot();
    if ((b.enabled || b.outcomeUnknown) && !external) { external = true; controller.invalidateForExternalSession(); }
    else if (b.stateKnown && !b.enabled) external = false;
    const m = view(controller.snapshot(), true, b.enabled ? 'Stop Wi-Fi bridge before Live Adjust' : data.busy ? 'Reading simulated data' : null, selection);
    m.telemetry = data.snapshot();
    m.telemetry.status = 'SIMULATED DATA | ' + m.telemetry.status;
    const bm = bridgeView(b, controller.snapshot().busy || data.busy), dm = carDataView(m.telemetry);
    m.bridgeStatus = bm.status; m.buttons = m.buttons.concat(bm.buttons, dm.buttons);
    return { m, b, bm, dm };
}
async function act(action) {
    const { m, bm, dm } = model();
    const button = m.buttons.concat(bm.buttons, dm.buttons).find((b) => b.name === action);
    if (!button || !button.enabled) return;
    if (!action.startsWith('BM3_DATA_')) data.stop();
    if (action === 'BM3_IDENTIFY') await controller.identify();
    else if (/^BM3_MAP_[1-4]$/.test(action)) await controller.select(Number(action.slice(-1)));
    else if (action === 'BM3_BURBLE_READ') { await controller.refreshBurble(); selection.burbleTarget = controller.snapshot().burbleAggression || 0; }
    else if (action === 'BM3_BURBLE_DOWN' || action === 'BM3_BURBLE_UP') selection.burbleTarget = m.burbleTarget + (action.endsWith('UP') ? 0.5 : -0.5);
    else if (action === 'BM3_BURBLE_APPLY') await controller.setBurble(m.burbleTarget);
    else if (action === 'BM3_BURBLE_OFF') await controller.disableBurble();
    else if (action === 'BM3_BRIDGE_REFRESH') await bridge.refresh();
    else if (action === 'BM3_BRIDGE_START') await bridge.start();
    else if (action === 'BM3_BRIDGE_STOP') await bridge.stop();
    else if (action === 'BM3_DATA_READ') await data.read();
    else if (action === 'BM3_DATA_LIVE') await data.start();
    else if (action === 'BM3_DATA_STOP') data.stop();
}
const html = `<!doctype html><meta charset="utf-8"><title>BM3 dashboard — offline simulation</title>
<style>*{box-sizing:border-box}body{margin:0;background:#03070d;color:#f2f6fc;font:16px system-ui}header{padding:22px 3%;display:flex;justify-content:space-between;color:#9aadc3}strong{color:#ffbb60;font-size:13px;letter-spacing:2px}main{max-width:1600px;margin:3vh auto}img{width:100%;display:block}nav{display:flex;gap:8px;padding:16px 30px;background:#101b28}button{flex:1;min-height:58px;border:1px solid #26394e;border-radius:9px;background:#141f2d;color:#f2f6fc;font:600 18px system-ui}button:focus-visible{outline:3px solid #76c9ff}button[aria-disabled=true]{color:#6e8198}footer{padding:22px 3%;color:#9aadc3}</style>
<header><span>BM3 Live Adjust / 0.6.1</span><strong>SIMULATION · NO VEHICLE CONNECTION</strong></header><main><img id="screen" alt="BM3 dashboard"><nav id="actions" aria-label="Keyboard equivalents of native controls"></nav></main><footer>Production dashboard pixels with native-action equivalents below. Tab and Enter test actions; Pages cycles five screens. All readings here are synthetic; valve commands remain unverified. This preview does not emulate BMW's HMI or GPU compositor.</footer>
<script>let rev=0,signature='';async function refresh(){let s=await(await fetch('/state')).json();document.getElementById('screen').src='/frame?'+(++rev);let next=JSON.stringify(s.buttons);if(next===signature)return;signature=next;let nav=document.getElementById('actions');nav.replaceChildren();s.buttons.forEach(b=>{let e=document.createElement('button');e.textContent=b.label;e.setAttribute('aria-disabled',!b.enabled);e.onclick=async()=>{await fetch('/action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:b.action})});await refresh()};nav.append(e)})}refresh();setInterval(refresh,1000)</script>`;
const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
        if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
        if (req.method === 'GET' && req.url === '/state') {
            const { m, bm, dm } = model(), all = m.buttons.concat(bm.buttons, dm.buttons);
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ buttons: pages[page].actions.map((action, i) => ({ action, label: pages[page].labels[i], enabled: !!all.find((b) => b.name === action && b.enabled) })).concat([{ action: 'page', label: 'Pages', enabled: true }]) }));
        }
        if (req.method === 'GET' && req.url.startsWith('/frame?')) {
            const { m, b, bm } = model(); res.setHeader('Content-Type', 'image/png');
            return res.end(drawFrame(page, controller.snapshot(), m, b, focus).canvas.png());
        }
        if (req.method === 'POST' && req.url === '/action') {
            if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) { res.statusCode = 403; return res.end(); }
            if (busy) { res.statusCode = 409; return res.end(); }
            busy = true;
            try {
                let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024) throw new Error('Request too large'); }
                const action = JSON.parse(body).action;
                if (action === 'page') { page = (page + 1) % pages.length; data.setActive(page === 4); focus = null; }
                else if (pages[page].actions.includes(action)) { focus = action; await act(action); }
                else { res.statusCode = 400; }
                return res.end('{}');
            } finally { busy = false; }
        }
        res.statusCode = 404; res.end();
    } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
});
const port = process.env.BM3_PREVIEW_PORT === undefined ? 8079 : Number(process.env.BM3_PREVIEW_PORT);
bridge.refresh().then(() => server.listen(port, '127.0.0.1', () => console.log('SIMULATED packaged dashboard: http://127.0.0.1:' + server.address().port)));
