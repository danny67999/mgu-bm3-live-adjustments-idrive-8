'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const zlib = require('zlib');
const cp = require('child_process');
const { build } = require('../tools/build');
const root = path.resolve(__dirname, '..');
const built = build();
const artifact = built.artifact;
const first = fs.readFileSync(artifact);
assert(first.equals(fs.readFileSync(build().artifact)), 'archive must be reproducible');
const tar = zlib.gunzipSync(first), files = new Map();
for (let offset = 0; offset < tar.length; ) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((byte) => byte === 0)) break;
    const cstring = (start, end) => h.subarray(start, end).toString().split('\0')[0];
    const base = cstring(0, 100), prefix = cstring(345, 500);
    const name = prefix ? prefix + '/' + base : base;
    const size = parseInt(cstring(124, 136).trim(), 8);
    assert.strictEqual(cstring(156, 157), '0', 'only regular files packed');
    assert(!path.isAbsolute(name) && !name.split('/').includes('..'));
    assert(!/node_modules|someipInterfaces|known_hosts|id_rsa|\.DS_Store|^\._/.test(name));
    assert(!files.has(name));
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
}
const json = (name) => JSON.parse(files.get(name).toString());
const source = json('mgu-app.json');
assert.strictEqual(source.schema, 1);
assert.strictEqual(source.modules[0], 'src/entry.js', 'explicit source-link bootstrap must be first');
assert.deepStrictEqual(require('../tools/oap_link').readManifest(built.staged), source);
const inTree = (name) => source.tree + '/' + name;
const treeJson = (name) => json(inTree(name));
const pkg = treeJson('package.json');
assert.strictEqual(pkg.name, 'bm3_live_id8');
assert.strictEqual(pkg.version, '0.1.1');
assert.strictEqual(pkg.mguLocalOnly, true);
assert.deepStrictEqual(pkg.mguHmi, ['ID8']);
assert.strictEqual(source.id, pkg.name);
assert.strictEqual(source.version, pkg.version);
assert.strictEqual(pkg.main, 'javascript/runner.js');
assert(!files.has(inTree(pkg.main)), 'unit linker supplies the compatible runner');
assert(!files.has(inTree('javascript/app.js')), 'SDK-linked output must never be distributed');
assert.deepStrictEqual(treeJson('config/vehicle.json'), {
    markerAddress: '807FFE50', identityMode: 'auto-marker', expectedRom: null,
    verifiedValveAdapter: null, experimentalValveAdapter: null
}, 'shared app must not ship a personal ROM pin or an unverified valve adapter');
assert.strictEqual(treeJson('config/vehicle.json').verifiedValveAdapter, null, 'community valve reference must stay unverified');
for (const name of ['vendor/LICENSE.idrive7-apps', 'vendor/LICENSE.mgu-store']) assert(files.has(inTree(name)));
for (const name of ['car_data', 'car_data_view', 'diag', 'bridge', 'bridge_view', 'sdk_signals', 'profiles', 'host', 'entry',
    'dashboard_frame', 'mgu_render_client']) assert(source.modules.includes('src/' + name + '.js'));
assert.deepStrictEqual(source.sdk, ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders']);
const profiles = treeJson('vendor/bm3-map-profiles.json');
assert.strictEqual(Object.keys(profiles).length, 137);
assert(!profiles.F4C9L8R5B, 'base ROM must not be guessed as runtime profile');
assert.deepStrictEqual(profiles.F4C9L8R02, { rom: 'F4C9L8R02', mapSwActAddr: '60038006', burbleActAddr: '60038099', wmbaCmd: '3e',
    liveTuneTables: { KF_DZWMIN_SPORT_SOT: { address: '60038100', factor: 2 } } });
const aliases = source.modules.map((file) => './' + path.basename(file));
for (const [name, content] of files) {
    if (name.endsWith('.js')) {
        new vm.Script(content.toString(), { filename: name });
        for (const match of content.toString().matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
            assert(aliases.includes(match[1]) || source.sdk.includes(match[1]) || require('module').builtinModules.includes(match[1]),
                'dependency must resolve with the actual unit linker: ' + name + ' -> ' + match[1]);
        }
    }
}
// Browserify's entry is not require.main: it must start explicitly once.
const probe = { exports: {} }; let starts = 0;
vm.runInNewContext(files.get('src/entry.js').toString(), { module: probe, console, process: {},
    require(name) {
        if (name === './startup_trace.js') return { trace() {} };
        assert.strictEqual(name, './host.js');
        return { Bm3App: class { start() { starts++; return Promise.resolve(); } } };
    } });
assert.strictEqual(starts, 1);
const generatedProfiles = { exports: {} };
vm.runInNewContext(files.get('src/profiles.js').toString(), { module: generatedProfiles });
assert.strictEqual(JSON.stringify(generatedProfiles.exports), JSON.stringify(profiles));
const app = treeJson('rhmiData/application.json').application;
assert.strictEqual(app.name, pkg.name);
const personalApp = require('./fixtures/prior-app-identity.json');
for (const key of ['uuid', 'stringBundleUuid', 'resourceBundleUuid']) assert.notStrictEqual(app[key], personalApp[key]);
assert.notStrictEqual(app.entryPoints[0].uuid, personalApp.entryPoints[0].uuid, 'side-by-side entry identity');
assert.notStrictEqual(pkg.oapAppSettings.loggingId, personalApp.loggingId);

for (const ui of app.uiDescriptions) {
    assert.deepStrictEqual(ui.hmi, ['ID8']);
    assert(files.has(inTree(path.posix.join('rhmiData', ui.applicationFilePath))));
    assert(files.has(inTree(path.posix.join('rhmiData', ui.uiDescriptionFilePath))));
}
const desc = treeJson('rhmiData/uiDescriptions/ID8/uiDescription.json');
const nativeXml = files.get(inTree('rhmiData/uiDescriptions/ID8/application.xml')).toString();
// Regression for the real ID8 initialize(INAVLID_PARAMETER) failure. Static
// property 1 is deliberately absent, matching the working Store's XML schema;
// stable native focus targets do not grant permission to execute an action.
assert(!/<property\s+id="1"(?:\s|\/)/.test(nativeXml), 'native XML must not declare Enabled');
for (const widget of Array.from(nativeXml.matchAll(/widget="([^"]+)"/g), (m) => m[1])) {
    assert(['LT_State_Wide_List', 'LT_ScrollLabel', 'LT_Button_MediaEntry_1Row'].includes(widget),
        'all states must work without the GPU using the observed ID8 widget contract: ' + widget);
}
for (const match of nativeXml.matchAll(/<property\s+id="(\d+)"/g)) {
    assert(['2', '3'].includes(match[1]), 'only known working Visible/Focusable static properties');
}
const uiIds = Array.from(nativeXml.matchAll(/<(?:container|layoutGroup|component)\s+id="(\d+)"/g), (match) => match[1]);
assert.strictEqual(new Set(uiIds).size, uiIds.length, 'native identifiers must be unique across all element types');
assert.strictEqual(desc.containers[2].name, 'ST_BM3_BRIDGE');
assert.strictEqual(desc.containers[3].name, 'ST_BM3_DATA');
for (let page = 0; page < require('../src/dashboard').pages.length; page++) {
    assert.strictEqual(desc.containers[100 + page].name, 'ST_BM3_DASH_' + page);
    assert(Object.values(desc.containers[100 + page].components).some((c) => c.name === 'DASH_STATUS_' + page));
}
for (const name of ['ui-fonts/label.json', 'ui-fonts/bold.json', 'ui-fonts/LICENCE-Ubuntu.txt', 'THIRD_PARTY_NOTICES.md']) assert(files.has(inTree(name)));
// Source archive membership alone did not catch 0.6.0: the on-unit npm
// repack omitted ui-fonts via package.files. Exercise that exact selection.
const npmFiles = JSON.parse(cp.execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd: built.packageTree, encoding: 'utf8', env: Object.assign({}, process.env, {
        npm_config_cache: path.join(built.staged, 'npm-cache'), npm_config_update_notifier: 'false'
    })
}))[0].files.map((entry) => entry.path);
for (const name of ['ui-fonts/label.json', 'ui-fonts/bold.json', 'ui-fonts/LICENCE-Ubuntu.txt', 'THIRD_PARTY_NOTICES.md']) {
    assert(npmFiles.includes(name), 'installed package must retain ' + name);
}
const fontProbe = { exports: {} };
vm.runInNewContext(files.get('src/pixel_fonts.js').toString(), {
    module: fontProbe, require, Buffer, __dirname: path.join(built.packageTree, 'javascript')
});
for (const family of ['label', 'bold']) {
    const atlas = fontProbe.exports.get(family, 24, 'MAP 2');
    assert(atlas && atlas.alpha.length === atlas.atlasW * atlas.atlasH && atlas.glyphs[77], 'font loads from installed bundle location');
}
assert.strictEqual(treeJson('npm-shrinkwrap.json').version, pkg.version);
const controls = Object.values(desc.containers).reduce((all, state) => all.concat(Object.values(state.components)), []);
for (const name of ['BM3_IDENTIFY', 'BM3_REFRESH', 'BM3_MAP_1', 'BM3_MAP_2', 'BM3_MAP_3', 'BM3_MAP_4',
    'BM3_BURBLE_READ', 'BM3_BURBLE_DOWN', 'BM3_BURBLE_UP', 'BM3_BURBLE_APPLY', 'BM3_BURBLE_OFF',
    'BM3_VALVE_OPEN', 'BM3_VALVE_CLOSED', 'BM3_VALVE_AUTO',
    'BM3_DATA_OPEN', 'BM3_DATA_READ', 'BM3_DATA_LIVE', 'BM3_DATA_STOP', 'BM3_DATA_BACK',
    'BM3_BRIDGE_OPEN', 'BM3_BRIDGE_BACK', 'BM3_BRIDGE_REFRESH', 'BM3_BRIDGE_START', 'BM3_BRIDGE_STOP']) {
    const c = controls.find((item) => item.name === name);
    assert(c && c.properties.Focusable.value === 3, 'every button remains a stable rotary focus target: ' + name);
}
for (const control of controls) {
    assert(!control.properties.Enabled, 'unsupported Enabled property must not be sent through JSON resources');
    if (control.type === 'button') assert(control.rows[0].PrimaryText, 'every ID8 button uses MediaEntry PrimaryText');
    if (control.type === 'label') assert.strictEqual(control.properties.Focusable.value, 0);
}
for (const match of nativeXml.matchAll(/<component\s+id="\d+"\s+type="(button|label)"[^>]*>([\s\S]*?)<\/component>/g)) {
    assert(match[2].includes('<property id="3" value="' + (match[1] === 'button' ? 3 : 0) + '"/>'), 'XML and JSON focus contracts must agree');
}
const manifest = treeJson('manifest.json');
const tasu = manifest.proxies['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu'];
assert.deepStrictEqual(tasu.methods, ['sendTasuRequest']);
assert.deepStrictEqual(tasu.broadcasts, ['sendTasuResponse']);
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'dist/catalog.json')));
const entry = catalog.components[0];
assert.strictEqual(catalog.schema, 2);
assert.strictEqual(entry.id, pkg.name);
assert.strictEqual(entry.version, pkg.version);
assert.strictEqual(entry.artifact.url, path.basename(artifact));
assert.strictEqual(entry.artifact.size, first.length);
assert.strictEqual(entry.artifact.sha256, crypto.createHash('sha256').update(first).digest('hex'));
assert.strictEqual(entry.build, 'unit', 'ID8 must prepare the source and link its own SDK');
console.log('Package verified: reproducible source archive, unit-link manifest, explicit bootstrap, ID8 resources, config lock, SDK-free module graph, licenses, 137 profiles, matching catalog digest.');

assert.deepStrictEqual(catalog.components[0].requires, { 'mgu-deploy': '0.6.9', 'mgu-render': '0.6.12' });

assert.deepStrictEqual(treeJson('rhmiData/application.json').application.variantGroups[0].brands, ['BMW', 'BMW_M'], 'M-car resource selection must not require emulator overrides');

assert.strictEqual(entry.artifact.name, entry.id + '@' + entry.version + '.tgz', 'Store catalogs require the canonical artifact name even for source builds');
