# OpenSpiRobs Design Tool — web

The [desktop design tool](../design-tool/) running in the browser, with no Python install.
Everything runs client-side: 2D geometry in TypeScript, CAD on OpenCascade (WebAssembly,
via [replicad](https://replicad.xyz)), and simulation on the official
[MuJoCo WebAssembly build](https://github.com/google-deepmind/mujoco/tree/main/wasm).

## Features

| Desktop tool | Web tool |
| --- | --- |
| 2D sketch: polar design + unfolded (Cartesian) view, taper / tip / base / length / units | same, plus hover read-out of x, y and the unit / joint under the cursor |
| 2D, fabrication, simulation and joint-pose parameters with the same ranges | same; ranges that depend on the geometry (extrusion, cone angles, filler sizes) update live |
| Generate 3D Model (VTK) | three.js view with B-rep edges, wireframe, hole cutters, site points, export-frame axes and a section plane; rebuilds automatically after each change |
| Export STEP / STL | same (binary STL, size-scaled tolerance) |
| Export XML (tendon dialog → `robot.xml` + `baselink.stl`) | same dialog; downloads `xml_<timestamp>.zip` with the two files |
| Save 2D Sketch (PNG/PDF) | zip with SVG + PNG of both plots, a 3D PNG and an SVG report |
| Save / reset parameters, `exports/last_params.json` | same JSON format (files move between the two tools), autosave in the browser, share links |
| open `robot.xml` in MuJoCo | **Simulation tab**: the exported model runs in MuJoCo inside the page, with actuator sliders, tendon / joint / tip read-outs, a tendon-length plot, play / pause / step / reset and speed control; any other `robot.xml` + meshes can be opened too |

### Debugging in the browser

* **Debug drawer** (bottom of the page): log with level filter, design-rule checks,
  the resolved parameters and derived values, changes from defaults, CAD timings
  per stage, the CAD worker's own log, triangle counts, fps and `mj_step` cost.
* **`window.osr`** in the DevTools console drives the whole app:

  ```js
  osr.set({ a: 5, two_cable: false, num_cables: 4 })
  osr.design()                       // polygons, sizes, rays …
  await osr.build()                  // CAD timings
  const { xml, stl } = await osr.exportXml()
  await osr.simulate()
  osr.sim.setCtrl(0, 1); osr.sim.step(500); osr.sim.readout()
  ```

* Add `?debug` to the URL to open the drawer at debug log level.

## Run

```bash
cd web
npm install
npm run dev          # http://localhost:5173 with hot reload
```

Production build and a dependency-free static server:

```bash
npm run build        # -> web/dist (static files, deployable anywhere)
npm run serve        # or: npx openspirobs-web --port 5180
```

`dist/` uses relative paths, so it can be served from any sub-path (GitHub Pages included).
The first visit downloads ~10 MB (gzip) of WebAssembly; browsers cache it afterwards.

## Tests

```bash
npm test
```

* `tests/parity.test.ts` — 2D geometry, elastic layer, filler sizes and the MuJoCo XML
  compared with the Python code. The XML must match `xml_generator.py` character for character.
* `tests/cad.test.ts` — OpenCascade solids compared with the desktop tool's CadQuery solids
  (volumes of body and elastic layer for 2-cable, 3-cable, 4-cable teardrop and posed models,
  within 1e-4), plus base link, STEP and cone-cut checks.
* `tests/sim.test.ts` — the generated XML compiles and steps in MuJoCo WASM.

The fixtures are produced by running the desktop tool's own functions
(extracted from `DesignTool.py` with `ast`, so no Qt/VTK is needed):

```bash
python3 web/tests/fixtures/gen_fixtures.py > web/tests/fixtures/python.json
# needs cadquery==2.6.1
python  web/tests/fixtures/gen_cad_fixtures.py > web/tests/fixtures/cad_python.json
```

Re-run them after changing the geometry in `design-tool/`.

## Layout

```
src/core/     parameters, 2D geometry, MuJoCo XML, file formats (pure, tested)
src/cad/      OpenCascade solids (cad.ts) in a web worker (worker.ts, client.ts)
src/sim/      MuJoCo WASM loader, stepping and rendering
src/ui/       panels, SVG sketches, three.js views, tendon dialog
src/debug/    log and debug drawer
bin/serve.mjs static server used by `npx openspirobs-web`
```

## License

PolyForm-Noncommercial-1.0.0, like the rest of the repository. The build bundles
OpenCascade (LGPL-2.1, via replicad-opencascadejs), replicad (MIT), MuJoCo (Apache-2.0)
and three.js (MIT).
