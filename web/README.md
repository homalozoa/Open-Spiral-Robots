# OpenSpiRobs Design Tool — web

The [desktop design tool](../design-tool/) running in the browser, with no Python install.
Everything runs client-side: 2D geometry in TypeScript, CAD on OpenCascade (WebAssembly,
via [replicad](https://replicad.xyz)), and simulation on the official
[MuJoCo WebAssembly build](https://github.com/google-deepmind/mujoco/tree/main/wasm).

## What it shows

The page opens on a full-screen, always-running MuJoCo simulation of the robot.
Every shape or size change recompiles the model in tens of milliseconds and the
motion carries on, so the robot is never "regenerated" — it morphs.

| Mode | What you can do |
| --- | --- |
| **Flexibility** | Steer the tendons with a cross-section joystick (2 cables: up/down, N cables: any direction), curl / relax / wave / circle presets, drag any link with the mouse to push it, drop a cylinder, sphere or box in the scene and let the robot wrap around it. Links are coloured by how much their joint bends. |
| **Speed** | *Strike*: tension a cable instantly from straight and measure the curl time t₉₀, the peak tip speed and the peak curl; the motion is shown as stroboscopic ghosts and a speed-coloured tip trail, and replays in slow motion (down to 1/100×). |
| **Scale** | One log slider takes the same design from 8 mm to 2.5 m. Physics scale like the same material (stiffness ∝ L³, damping ∝ L⁴, tendon force ∝ L²), so a 10× smaller robot curls 10× faster while the peak tip speed stays the same — measured points land on the t ∝ L line of the scaling-law chart. A coin, a hand and a person give the sense of size. |

The left panel holds the intuitive shape controls (length, cable count, unit
angle, spiral turns, taper, centre line, gravity); the bottom timeline charts
curl and tip speed and can be scrubbed to replay any moment.

### Engineering drawer

**⚙ Engineering** opens the complete design tool on top of the stage:

| Desktop tool | Engineering drawer |
| --- | --- |
| 2D sketch: polar design + unfolded (Cartesian) view, taper / tip / base / length / units | same, plus hover read-out of x, y and the unit / joint under the cursor |
| All parameters with the same ranges | same; geometry-dependent ranges update live |
| Generate 3D Model (VTK) | exact OpenCascade model with B-rep edges, wireframe, hole cutters, site points, export-frame axes, section plane |
| Export STEP / STL | same |
| Export XML (tendon dialog → `robot.xml` + `baselink.stl`) | same dialog; downloads `xml_<timestamp>.zip` |
| Save 2D Sketch (PNG + PDF report) | zip with SVG, PNG and vector PDF of both plots, a 3D PNG and the report as PDF and SVG; **Save PDF Report** downloads the one-page report |
| `exports/last_params.json` | same JSON format, autosave in the browser, share links |

### How the live simulation stays fast and stable

* **Physics in a Web Worker** (`src/showcase/worker.ts`): compiling and stepping
  never block the UI; the worker streams link poses (~7 floats per link) to the
  renderer.
* **Procedural link mesh** (`src/core/linkMesh.ts`) instead of OpenCascade for
  the live model: well under a millisecond per rebuild. The exact CAD solid is
  only built for exports.
* **Similarity units**: the model is always simulated at the reference size
  (length unit λ = L / 46.4 cm, mass λ³, time λ), where the scaled robot is
  numerically the reference robot and only gravity changes. Millimetre and metre
  robots are equally well conditioned; positions and times are converted back.
* Link-to-link self collision is off (joint limits already bound the curl);
  links still collide with the ground and the scene object.

### Debugging in the browser

* The engineering drawer has a **debug drawer**: log with level filter,
  design-rule checks, resolved parameters, CAD timings, physics step cost, fps.
* **`window.osr`** in the DevTools console drives the whole app:

  ```js
  osr.mode("speed"); await osr.strike(); osr.lastStrike()   // t90, vmax, peak curl
  osr.setLength(20)                     // 2 cm robot
  osr.setDirection(0, 1)                // pull the cable on +Y
  osr.object("cylinder")
  osr.set({ a: 5, two_cable: false, num_cables: 4 })
  const { xml, stl } = await osr.exportXml()
  ```

* Add `?debug` to the URL to open the debug drawer at debug log level.

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
* `tests/sim.test.ts` — the generated XML (real design geometry) compiles in MuJoCo WASM,
  tendon 1 produces joint torque in the straight pose and the chain curls.
* `tests/physics.test.ts` — the live showcase physics: procedural mesh volume,
  state kept across rebuilds, tendon direction mapping, the t ∝ L scaling law
  and stability from 8 mm to 2.5 m.
* `tests/pdf.test.ts` — the PDF writer's cross-reference table and text encoding.

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
src/core/     parameters, 2D geometry, MuJoCo XML, STL/ZIP/PDF writers (pure, tested)
src/cad/      OpenCascade solids (cad.ts) in a web worker (worker.ts, client.ts)
src/showcase/ live stage: physics worker, three.js stage, widgets, i18n
src/engineering/ the full design tool mounted in the Engineering drawer
src/sim/      MuJoCo WASM loader
src/ui/       panels, SVG sketches, CAD view, tendon dialog, PDF rendering
src/debug/    log and debug drawer
bin/serve.mjs static server used by `npx openspirobs-web`
```

## License

PolyForm-Noncommercial-1.0.0, like the rest of the repository. The build bundles
OpenCascade (LGPL-2.1, via replicad-opencascadejs), replicad (MIT), MuJoCo (Apache-2.0)
and three.js (MIT).
