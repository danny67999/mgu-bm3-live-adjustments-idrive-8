# Source provenance and licenses

## idrive7-apps

- Source: https://github.com/cauliflowermossgrape/idrive7-apps
- Inspected commit: `bd5ce85bf584db51382ace1a4d8ead5ae27fef40`
- License: MIT; full notice in `vendor/LICENSE.idrive7-apps`.
- Used: BM3 map and burble profile metadata/protocol, plus a separately gated community valve reference, credited upstream to BM3 Live by ezl0l; diagnostic SOME/IP helpers from `kit/runtime/diag.js` and `signals.js`.
- Changes: narrowly scoped map/burble actions, exact marker-token matching, operation-level serialization, explicit identification/current-state reads, fail-closed state management, no retry writes, native ID8 host integration. Valve reference provenance and verification limits are detailed in `docs/VALVES.md`; its presence does not certify official bootmod3 valve support.

## MGU Store

- Source: https://github.com/robertnisipeanu/mgu-store
- Inspected commit: `675fe6140795e38d8f6c34fd0cbef163ba9e9a5d`
- License: GNU GPL version 3; full license in `LICENSE`.
- Used: native ID8 OnlineApp/widget structure, reproducible OAP archive helper, `tools/oap_link.js` source-package linker, and `native/mgu-render/js/mgu_render_client.js`. See file headers for adaptations. The app invokes the donor SDK's proxy builder on the unit; that SDK is not included.

The combined derivative is distributed under GPL-3.0-or-later; original MIT notices remain in force for those portions. Corresponding editable source is provided in this directory. No BMW SDK, BMW firmware, tuner ROM image, account token, SSH key, or tune calibration is included.

IterioDev's `car-apps` was inspected for compatibility and licensing context only. Its restricted application code and assets are not included or modified. The separately published MGU Store renderer client credits the MIT-licensed community `kit/runtime/renderd.js`, including shared touch/picture support; those upstream credits are retained in the file.

## Native dashboard rendering (0.5.0)

`src/pixel_canvas.js` and `src/pixel_fonts.js` derive from the MIT-licensed idrive7-apps kit/runtime canvas.js and fonts.js in the existing local checkout. The English-only translation shim is app code. `ui-fonts/label.json` and `ui-fonts/bold.json` are the upstream baked Ubuntu font atlases. The upstream MIT license remains in vendor/LICENSE.idrive7-apps; the Ubuntu font license accompanies the atlases. No BMW SDK or captured firmware data is included.

## Renderer integration (0.6.1)

`src/mgu_render_client.js` is adapted from the MGU Store checkout identified above. The local change clears partial input and stale capabilities when a renderer socket reconnects. `src/dashboard_host.js` and `src/dashboard_frame.js` connect the app's software-drawn RGBA canvas to that client and use native ID8 lists for rotary focus and fallback. No native renderer binary or firmware is distributed with this app.
