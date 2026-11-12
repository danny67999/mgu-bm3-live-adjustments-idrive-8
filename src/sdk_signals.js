'use strict';
// SDK-linked InternalTasu adapter. The native proxy is owned by the donor SDK;
// no missing node_modules/oap-sdk or direct external someip dependency is needed.
const builders = require('oap-sdk/src/someip/someipBuilders');
let queue = Promise.resolve();
function nativeTick(action) {
    const run = () => new Promise((resolve, reject) => setImmediate(() => {
        try { Promise.resolve(action()).then(resolve, reject); } catch (error) { reject(error); }
    }));
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
}
async function proxy(iface, instance) {
    const typed = await builders.buildTypedProxy(iface, String(instance));
    await typed.init();
    if (!typed._someIpProxy) throw new Error('The donor SDK did not expose an initialized native diagnostic proxy');
    return typed._someIpProxy;
}
function call(proxy, method, params, timeoutMs) {
    return nativeTick(() => proxy.callMethod(method, params || {}, timeoutMs || 5000));
}
function on(proxy, name, receive, log) {
    return nativeTick(() => proxy.subscribe({ name, onReceive(value) {
        try { receive(value); } catch (error) { if (log) log.warn(name + ': ' + error.message); }
    } }));
}
function onAvailable(proxy, receive) {
    return nativeTick(() => proxy.subscribeToAvailability((available) => receive(!!available)))
        .then(() => { if (proxy.isAvailable && proxy.isAvailable()) receive(true); });
}
module.exports = { proxy, call, on, onAvailable };
