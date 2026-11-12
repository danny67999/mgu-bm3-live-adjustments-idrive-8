'use strict';
const { pages, draw } = require('./dashboard');
const { Canvas } = require('./pixel_canvas');
const W = 1600, H = 610;

function createBuffers() { return { canvas: new Canvas(W, H), content: new Canvas(W, 520) }; }
function drawFrame(page, state, model, bridge, focus, buffers) {
    const pool = buffers || createBuffers();
    const cv = pool.canvas.clear('#080d15');
    cv.d.set(draw(page, state, model, bridge, { status: model.bridgeStatus }, focus, pool.content).d);
    const labels = pages[page].labels.concat(['Pages', 'List']);
    const actions = pages[page].actions.concat(['page-next', 'list']);
    const gap = 12, width = (1536 - (labels.length - 1) * gap) / labels.length;
    const regions = [];
    labels.forEach((label, i) => {
        const action = actions[i], x = 32 + i * (width + gap);
        const button = model.buttons.find((b) => b.name === action), enabled = !button || button.enabled;
        const selected = focus === action;
        cv.roundRect(x, 531, width, 59, 9, selected ? '#16344b' : '#141f2d');
        cv.strokeRoundRect(x, 531, width, 59, 9, selected ? 3 : 1, selected ? '#76c9ff' : '#26394e');
        cv.text(label, x + width / 2, 569, 24, enabled ? '#f2f6fc' : '#758296', { font: 'bold', align: 'center' });
        regions.push({ action, x, y: 531, w: width, h: 59 });
    });
    return { canvas: cv, regions };
}

function hitFrame(regions, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (y >= 12 && y <= 61 && x >= 436 && x < 1556) return 'page-' + Math.floor((x - 436) / 224);
    const region = regions.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h);
    return region ? region.action : null;
}
module.exports = { W, H, createBuffers, drawFrame, hitFrame };
