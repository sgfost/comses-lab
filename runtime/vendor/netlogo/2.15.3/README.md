# NetLogo Web 2.15.3

`player.html` is the unmodified standalone NetLogo Web distribution. It contains the Galapagos interface and Tortoise compiler and simulation engine. `provenance.json` records its download URL, exact SHA-256 digest, size, and upstream source revisions. `upstream-package.json` records Galapagos's dependency versions at that revision.

Run `node scripts/netlogo-runtime.mjs` to verify the checked-in bytes. Use `node scripts/netlogo-runtime.mjs --download` to restore this exact version from upstream; mismatched downloads are rejected before writing.

## Licenses and source

Galapagos and Tortoise are GPL-2.0-or-later. Their license notices are included beside the player. The corresponding source is available at the exact revisions in `provenance.json`, including upstream build instructions and dependency declarations. Preserve the notices embedded in the HTML when distributing or modifying it.

Dependencies have their own terms. In particular, the bundled **Highcharts 10.3.1** uses the [Highsoft license](https://www.highcharts.com/license), not GPL; a commercial deployment must have appropriate Highcharts rights. The upstream project's GPL license does not grant those rights. The player also retains the Open Sans SIL Open Font License notice and notices for its JavaScript dependencies. See the pinned source's package and build files for the full dependency graph.

The standalone player references Google's Open Sans stylesheet, but the simulation does not require network access to load its engine, compiler, controls, charts, or bundled color picker. Lab strips the remote stylesheet links from its served player and uses local font fallbacks.

Runtime compatibility is defined by this pinned upstream release. Do not silently update the bundle: verify the new release's loading placeholder, message/event contracts, exports, extensions, licensing, and browser sandbox behavior first.
