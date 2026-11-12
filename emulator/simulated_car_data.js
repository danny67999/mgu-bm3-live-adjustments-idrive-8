'use strict';
// Synthetic fixtures only; these bytes were not captured from the owner's DME.
const replies = {
    0x00: [0x08, 0x3A, 0x00, 0x01],
    0x20: [0x00, 0x02, 0x20, 0x01],
    0x40: [0x40, 0x00, 0x40, 0x10],
    0x52: [128], 0x0C: [0x1F, 0x40], 0x0D: [0], 0x05: [130],
    0x0F: [70], 0x0B: [150], 0x33: [100], 0x42: [0x39, 0x94], 0x5C: [145], 0x2F: [160]
};
class SimulatedCarData {
    constructor() { this.available = true; this.calls = []; }
    async physical(ecu, sid, data) {
        this.calls.push({ ecu, sid, data: data.slice() });
        if (ecu !== 0x12 || sid !== 1 || data.length !== 1 || !replies[data[0]]) throw new Error('Unexpected simulation request');
        return [0x41, data[0]].concat(replies[data[0]]);
    }
}
module.exports = { SimulatedCarData, replies };
