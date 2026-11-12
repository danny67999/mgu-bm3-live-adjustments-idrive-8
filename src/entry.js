'use strict';
// oap_link executes this module as the Browserify entry. require.main is the
// donor runner, not an app module, so the bootstrap must be explicit here.
const { trace } = require('./startup_trace');
trace('entry:bootstrap', '0.1.1');
try {
    const { Bm3App } = require('./host');
    trace('entry:host-loaded');
    const app = new Bm3App();
    trace('entry:constructed');
    if (process.on) {
        // The SDK already owns its uncaught-exception policy; observe it only.
        if (process.listenerCount && process.listenerCount('uncaughtException') > 0) {
            process.on('uncaughtException', (error) => trace('process:uncaughtException', error));
        }
        process.on('unhandledRejection', (error) => trace('process:unhandledRejection', error));
    }
    trace('entry:start');
    Promise.resolve(app.start()).then(() => trace('entry:start-resolved')).catch((error) => {
        trace('entry:start-error', error);
        console.error('BM3 startup: ' + (error.stack || error.message || error));
    });
    module.exports = app;
} catch (error) {
    trace('entry:load-error', error);
    throw error;
}
