'use strict';
// Source-only OAP packaging. BMW SDK and generated SOME/IP definitions stay on the unit.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { packSource, readManifest } = require('./oap_link');
const ROOT = path.resolve(__dirname, '..');

function mkdir(dir) {
    if (fs.existsSync(dir)) return;
    mkdir(path.dirname(dir));
    fs.mkdirSync(dir);
}

function copy(from, to) {
    if (fs.statSync(from).isDirectory()) {
        mkdir(to);
        fs.readdirSync(from).sort().forEach((name) => {
            if (name === '.DS_Store' || name.indexOf('._') === 0) return;
            copy(path.join(from, name), path.join(to, name));
        });
    } else { mkdir(path.dirname(to)); fs.writeFileSync(to, fs.readFileSync(from)); }
}

function json(file, object) { fs.writeFileSync(file, JSON.stringify(object, null, 2) + '\n'); }

function rhmi(staged) {
    const directory = path.join(staged, 'rhmiData', 'uiDescriptions', 'ID8');
    mkdir(directory);
    const controls = [
        { id: 38, name: 'BM3_DASHBOARD_OPEN', text: 'Graphical dashboard' },
        { id: 39, name: 'BM3_DATA_OPEN', text: 'Vehicle Data' },
        { id: 37, name: 'BM3_BRIDGE_OPEN', text: 'Wi-Fi Bridge' },
        { id: 20, name: 'BM3_STATUS', text: 'Identify BM3 to read the current map', label: true },
        { id: 21, name: 'BM3_IDENTIFY', text: 'Identify BM3' },
        { id: 22, name: 'BM3_REFRESH', text: 'Refresh current map' }
    ].concat([1, 2, 3, 4].map((slot) => ({ id: 22 + slot, name: 'BM3_MAP_' + slot, text: 'Map ' + slot })), [
        { id: 27, name: 'BM3_BURBLE_STATUS', text: 'Burbles not read; Off zeros timing rather than restoring the tune', label: true },
        { id: 28, name: 'BM3_BURBLE_READ', text: 'Read burble settings' },
        { id: 29, name: 'BM3_BURBLE_DOWN', text: 'Select −0.5 aggression' },
        { id: 30, name: 'BM3_BURBLE_UP', text: 'Select +0.5 aggression' },
        { id: 31, name: 'BM3_BURBLE_APPLY', text: 'Apply selected burble aggression' },
        { id: 32, name: 'BM3_BURBLE_OFF', text: 'Burbles Off (zero timing table)' },
        { id: 33, name: 'BM3_VALVE_STATUS', text: 'BM3 valves; identify BM3 to begin', label: true },
        { id: 34, name: 'BM3_VALVE_OPEN', text: 'BM3 valves open' },
        { id: 35, name: 'BM3_VALVE_CLOSED', text: 'BM3 valves closed' },
        { id: 36, name: 'BM3_VALVE_AUTO', text: 'BM3 valves auto' }
    ]);
    const bridgeControls = [
        { id: 120, name: 'BM3_BRIDGE_STATUS', text: 'Checking Wi-Fi bridge...', label: true },
        { id: 121, name: 'BM3_BRIDGE_REFRESH', text: 'Refresh bridge status' },
        { id: 122, name: 'BM3_BRIDGE_START', text: 'Start Wi-Fi bridge' },
        { id: 123, name: 'BM3_BRIDGE_STOP', text: 'Stop Wi-Fi bridge' },
        { id: 124, name: 'BM3_BRIDGE_DETAIL_STATUS', text: 'Connect iPhone to the BMW hotspot. Keep Router blank for cellular internet.', label: true },
        { id: 125, name: 'BM3_BRIDGE_BACK', text: 'Back to Live Adjust' }
    ];
    const dataControls = [
        { id: 140, name: 'BM3_DATA_STATUS', text: 'Press Read to check advertised data channels', label: true },
        { id: 141, name: 'BM3_DATA_READ', text: 'Read vehicle data' },
        { id: 142, name: 'BM3_DATA_LIVE', text: 'Start live data' },
        { id: 143, name: 'BM3_DATA_STOP', text: 'Stop reading data' },
        { id: 144, name: 'BM3_DATA_DETAIL_STATUS', text: 'Vehicle data not read', label: true },
        { id: 145, name: 'BM3_DATA_BACK', text: 'Back to Live Adjust' }
    ];
    const containers = {};
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    function state(id, name, titleId, titleName, title, rows) {
        const components = {};
        components[titleId] = { type: 'title', name: titleName, properties: { Visible: { value: 1, type: 'UInt' } },
            rows: [{ Text: { value: title, type: 'Text' } }] };
        containers[id] = { type: 'state', name, components };
        xml.push('  <container id="' + id + '" type="state" widget="LT_State_Wide_List">',
            '    <layoutGroup id="' + (id + 1000) + '" name="Titlebar">',
            '      <component id="' + titleId + '" type="title"><property id="2" value="1"/></component>',
            '    </layoutGroup>', '    <layoutGroup id="' + (id + 2000) + '" name="List"><property id="3" value="1"/>');
    rows.forEach((control) => {
        // Navigation and permission to act are separate. Stable native focus
        // targets keep the controller scrollable while actions are unavailable.
        const focusable = control.label ? 0 : 3;
        const type = control.label ? 'label' : 'button';
        const widget = control.label ? 'LT_ScrollLabel' : 'LT_Button_MediaEntry_1Row';
        const row = control.label ? { Text: { value: control.text, type: 'Text' } } : {
            PrimaryText: { value: control.text, type: 'Text' }, FrequencyText: { value: '', type: 'Text' },
            FrequencyVisible: { value: false, type: 'Bool' }, IconVisible: { value: false, type: 'Bool' },
            ProgressVisible: { value: false, type: 'Bool' }, IsPlaying: { value: false, type: 'Bool' }
        };
        components[control.id] = { type, name: control.name,
            properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: focusable, type: 'UInt' } }, rows: [row] };
        xml.push('      <component id="' + control.id + '" type="' + type + '" widget="' + widget + '">',
            // Match the working ID8 Store XML contract: Visible and Focusable
            // only. Omit the static Enabled declarations while diagnosing the
            // native initialize rejection; runtime action gates remain.
            '        <property id="2" value="1"/><property id="3" value="' + focusable + '"/>', '      </component>');
    });
        xml.push('    </layoutGroup>', '  </container>');
    }
    state(1, 'ST_BM3_MAIN', 10, 'BM3_TITLE', 'BM3 Live Adjust', controls);
    state(2, 'ST_BM3_BRIDGE', 110, 'BM3_BRIDGE_TITLE', 'Wi-Fi Bridge', bridgeControls);
    state(3, 'ST_BM3_DATA', 130, 'BM3_DATA_TITLE', 'Vehicle Data', dataControls);
    const pages = require('../src/dashboard').pages;
    pages.forEach((page, index) => {
        const id = 100 + index, base = 300 + index * 20;
        const rows = [{ id: base + 11, name: 'DASH_STATUS_' + index,
            text: 'BM3 ' + page.title + ' | Waiting for status', label: true }];
        page.labels.concat(['Pages', 'List']).forEach((label, item) => {
            const suffix = item < page.actions.length ? item : item === page.actions.length ? 'PAGE' : 'LIST';
            rows.push({ id: base + item + 1, name: 'DASH_' + index + '_' + suffix, text: label });
        });
        // These are the same ID8 widgets as the working native list. They
        // provide rotary focus and a usable fallback behind mgu-render.
        state(id, 'ST_BM3_DASH_' + index, base + 10, 'DASH_TITLE_' + index, 'BM3 ' + page.title, rows);
    });
    xml.push('</application>', '');
    fs.writeFileSync(path.join(directory, 'application.xml'), xml.join('\n'));
    json(path.join(directory, 'uiDescription.json'), { schemaVersion: '1.3.0', containers });
}

function build() {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'template', 'package.json'), 'utf8'));
    const release = JSON.parse(fs.readFileSync(path.join(ROOT, 'release.json'), 'utf8'));
    const output = path.resolve(process.env.MGU_OUT || path.join(ROOT, 'dist'));
    mkdir(output);
    mkdir(path.join(ROOT, 'work'));
    const staged = fs.mkdtempSync(path.join(ROOT, 'work', 'source-'));
    const tree = pkg.name + '@' + pkg.version;
    const packageTree = path.join(staged, tree);
    copy(path.join(ROOT, 'template'), packageTree);
    copy(path.join(ROOT, 'vendor'), path.join(packageTree, 'vendor'));
    mkdir(path.join(packageTree, 'config'));
    const configuration = path.join(ROOT, 'config', 'vehicle.json');
    if (fs.existsSync(configuration)) copy(configuration, path.join(packageTree, 'config', 'vehicle.json'));
    else json(path.join(packageTree, 'config', 'vehicle.json'), { markerAddress: null, verifiedValveAdapter: null });
    copy(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), path.join(packageTree, 'THIRD_PARTY_NOTICES.md'));
    copy(path.join(ROOT, 'ui-fonts'), path.join(packageTree, 'ui-fonts'));
    rhmi(packageTree);
    // Source packages deliberately contain no SDK or built runner. The unit's
    // source linker obtains its own compatible SDK from an installed BMW app.
    const moduleNames = ['entry.js'].concat(fs.readdirSync(path.join(ROOT, 'src'))
        .filter((name) => /\.js$/.test(name) && name !== 'entry.js').sort());
    mkdir(path.join(staged, 'src'));
    const modules = moduleNames.concat(['diag.js', 'profiles.js']).map((name) => 'src/' + name);
    moduleNames.forEach((name) => {
        const source = fs.readFileSync(path.join(ROOT, 'src', name), 'utf8')
            .replace(/require\('(\.[^']+)'\)/g, (expression, dependency) => {
                if (dependency === '../vendor/bm3-map-profiles.json') return "require('./profiles.js')";
                const basename = path.basename(dependency);
                const target = basename.endsWith('.js') ? basename : basename + '.js';
                if (!modules.includes('src/' + target)) throw new Error('Unlisted source dependency: ' + dependency);
                return "require('./" + target + "')";
            });
        fs.writeFileSync(path.join(staged, 'src', name), source);
    });
    copy(path.join(ROOT, 'kit', 'diag.js'), path.join(staged, 'src', 'diag.js'));
    const profiles = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'bm3-map-profiles.json'), 'utf8'));
    fs.writeFileSync(path.join(staged, 'src', 'profiles.js'), "'use strict';\nmodule.exports = " + JSON.stringify(profiles, null, 2) + ';\n');
    json(path.join(staged, 'mgu-app.json'), { schema: 1, id: pkg.name, version: pkg.version, tree,
        modules, sdk: ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders'], mguHmi: ['ID8'] });
    const sourceManifest = readManifest(staged);
    const artifact = path.join(output, pkg.name + '@' + pkg.version + '.tgz');
    const members = packSource(staged, artifact);
    const bytes = fs.readFileSync(artifact);
    const entry = { id: pkg.name, kind: 'app', title: release.title, description: pkg.description,
        version: pkg.version, build: 'unit', mguHmi: release.mguHmi, requires: release.requires,
        artifact: { name: path.basename(artifact), url: path.basename(artifact), size: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
    if (!process.env.MGU_OUT) json(path.join(output, 'catalog.json'), { schema: 2, components: [entry] });
    return { artifact, staged, packageTree, files: members.length, sdkIncluded: false, format: 'source', manifest: sourceManifest };
}

if (require.main === module) {
    try { console.log(JSON.stringify(build(), null, 2)); }
    catch (e) { console.error('build: ' + e.message); process.exitCode = 1; }
}
module.exports = { build, rhmi };
