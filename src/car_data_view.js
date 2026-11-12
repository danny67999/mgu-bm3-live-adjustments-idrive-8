'use strict';
// Pure display model; no requests or timers.
function carDataView(snapshot) {
    const s = snapshot || { values: {}, status: 'Press Read to check vehicle data.' };
    const available = !s.blocked && !s.busy;
    const metric = (key, digits) => {
        const sample = s.values[key] || {};
        const valid = sample.status === 'valid' && Number.isFinite(sample.value);
        const previous = sample.status === 'stale' && Number.isFinite(sample.lastValue);
        const value = valid ? sample.value : sample.lastValue;
        return { value: valid || previous ? (sample.lowerBound ? '>=' : '') + value.toFixed(digits) : '--', unit: sample.unit || '',
            fresh: valid,
            status: valid ? sample.lowerBound ? 'RANGE LIMIT' : 'LATEST SAMPLE' : previous ? 'LAST SAMPLE' :
                sample.status === 'unsupported' ? 'NOT EXPOSED' : sample.status === 'stale' ? 'STALE / PAUSED' : 'NOT READ' };
    };
    return {
        status: s.status,
        metrics: { boost: metric('boost', 1), oil: metric('oil', 0),
            coolant: metric('coolant', 0), intake: metric('intake', 0), voltage: metric('voltage', 2),
            rpm: metric('rpm', 0), speed: metric('speed', 0), fuel: metric('fuel', 0) },
        buttons: [
            { name: 'BM3_DATA_READ', text: 'Read vehicle data', enabled: !!available },
            { name: 'BM3_DATA_LIVE', text: 'Start live data', enabled: !!(available && !s.live) },
            { name: 'BM3_DATA_STOP', text: 'Stop reading data', enabled: !!(s.live || s.busy) }
        ]
    };
}
module.exports = { carDataView };
