# Development and release packaging

`npm run build` produces the source package and catalog under `dist/`. `npm run audit` checks that the archive contains app source and resources rather than SDK-linked output or firmware. The head unit supplies its own installed BMW SDK when MGU Store builds the package.

After source changes, run `python3 tools/build_store_tree.py` to regenerate the SDK-free `store/bm3_live_id8` tree used by branch installations. Commit that tree alongside the editable source. CI verifies that it matches the build.

Keep compiled SDK-linked packages, firmware libraries, emulator images, credentials and raw vehicle captures outside this repository. Retain the GPL, MIT and Ubuntu font notices in distributed packages.

ROM definitions come from the credited community sources. The compatibility suite exercises 269 synthetic ROM/marker combinations across 137 definitions. Synthetic checks establish parser and controller behavior, rather than compatibility with every physical vehicle. Vehicle-specific testing should record the ROM and features exercised.

The screenshot viewer combines the emulator's actual Hmi8 framebuffer and native mgu-render output at the renderer-reported application area. The screenshots show its disconnected diagnostic state.
