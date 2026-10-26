// Simulation tab: transport controls, actuator sliders, live readouts and a
// rolling plot of tendon lengths — the "debug the robot in the browser" view.

import { Simulator, type SimReadout } from "../sim/sim";
import { logger } from "../debug/log";
import { button, el } from "./controls";
import { TENDON_COLORS } from "./tendonDialog";

const log = logger("sim");

export interface SimPanel {
  root: HTMLElement;
  sim: Simulator;
  load(xml: string, assets: Record<string, Uint8Array>, label: string): Promise<void>;
  markStale(stale: boolean): void;
}

export function buildSimPanel(onLoadCurrent: () => void): SimPanel {
  const viewHost = el("div", { class: "view-host" });
  const overlay = el("div", { class: "view-overlay" }, "Load the current design to simulate it with MuJoCo (WASM).");
  const sim = new Simulator(viewHost, (lvl, m) => log[lvl](m));

  const title = el("span", { class: "sim-title" }, "No model");
  const stale = el("span", { class: "badge warn", hidden: true }, "design changed — reload");
  const play = button("▶ Play", () => setRunning(!sim.running), "btn primary");
  const setRunning = (on: boolean) => {
    if (!sim.loaded) return;
    sim.running = on;
    play.textContent = on ? "⏸ Pause" : "▶ Play";
  };
  const speed = el("select", { "aria-label": "Speed", title: "Simulation speed" });
  for (const s of [0.1, 0.25, 0.5, 1, 2, 4]) speed.append(el("option", { value: s, selected: s === 1 }, `${s}×`));
  speed.addEventListener("change", () => (sim.speed = Number(speed.value)));

  const fileInput = el("input", { type: "file", accept: ".xml,.stl,.obj,.msh", multiple: true, hidden: true });
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    const xmlFile = files.find((f) => f.name.toLowerCase().endsWith(".xml"));
    if (!xmlFile) {
      log.error("Choose a MuJoCo .xml file together with the mesh files it references.");
      return;
    }
    const assets: Record<string, Uint8Array> = {};
    for (const f of files) if (f !== xmlFile) assets[f.name] = new Uint8Array(await f.arrayBuffer());
    await panel.load(await xmlFile.text(), assets, xmlFile.name);
  });

  const toggles = el(
    "div",
    { class: "inline" },
    checkbox("Sites", true, (v) => (sim.showSites = v)),
    checkbox("Tendons", true, (v) => (sim.showTendons = v)),
  );
  const toolbar = el(
    "div",
    { class: "toolbar" },
    button("Load current design", onLoadCurrent, "btn primary", "Export robot.xml + baselink.stl from the current parameters and load them"),
    button("Open XML…", () => fileInput.click(), "btn", "Load any robot.xml with its mesh files"),
    el("span", { class: "sep" }),
    play,
    button("Step", () => sim.step(1), "btn", "One mj_step"),
    button("Reset", () => sim.reset(), "btn", "mj_resetData (keeps controls)"),
    speed,
    button("Fit", () => sim.resetView(), "btn"),
    toggles,
    fileInput,
  );

  const actuators = el("div", { class: "act-list" });
  const readout = el("div", { class: "readout" });
  const chart = el("canvas", { class: "chart", width: 600, height: 140 });
  const side = el(
    "div",
    { class: "sim-side" },
    el("div", { class: "sim-head" }, title, stale),
    el("h4", {}, "Actuators"),
    actuators,
    el("div", { class: "row" }, button("Zero all", () => zeroAll(), "btn small")),
    el("h4", {}, "State"),
    readout,
    el("h4", {}, "Tendon length (mm)"),
    chart,
  );

  const sliders: HTMLInputElement[] = [];
  const zeroAll = () => {
    sliders.forEach((s, i) => {
      s.value = "0";
      sim.setCtrl(i, 0);
      s.dispatchEvent(new Event("input"));
    });
  };
  const buildActuators = () => {
    actuators.replaceChildren();
    sliders.length = 0;
    sim.actuators.forEach((a, i) => {
      const val = el("span", { class: "mono" }, "0.00");
      const s = el("input", { type: "range", min: a.lo, max: a.hi, step: (a.hi - a.lo) / 200 || 0.01, value: Math.max(a.lo, Math.min(a.hi, 0)), "aria-label": a.name });
      s.addEventListener("input", () => {
        sim.setCtrl(i, Number(s.value));
        val.textContent = Number(s.value).toFixed(2);
      });
      sliders.push(s);
      actuators.append(el("div", { class: "act-row" }, el("span", { class: "dot", style: `background:${TENDON_COLORS[i % TENDON_COLORS.length]}` }), el("span", {}, a.name), s, val));
    });
  };

  const history: number[][] = [];
  let lastSample = 0;
  const draw = () => {
    const g = chart.getContext("2d")!;
    const W = (chart.width = chart.clientWidth * devicePixelRatio || 600);
    const H = (chart.height = chart.clientHeight * devicePixelRatio || 140);
    g.clearRect(0, 0, W, H);
    if (history.length < 2) return;
    const n = history[0].length;
    let lo = Infinity;
    let hi = -Infinity;
    history.forEach((r) => r.forEach((v) => ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)))));
    if (hi - lo < 1e-9) {
      hi += 0.5;
      lo -= 0.5;
    }
    g.lineWidth = 1.5 * devicePixelRatio;
    for (let k = 0; k < n; k++) {
      g.strokeStyle = TENDON_COLORS[k % TENDON_COLORS.length];
      g.beginPath();
      history.forEach((r, i) => {
        const x = (i / (history.length - 1)) * W;
        const y = H - ((r[k] - lo) / (hi - lo)) * (H - 16) - 8;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.stroke();
    }
    g.fillStyle = getComputedStyle(chart).color;
    g.font = `${10 * devicePixelRatio}px system-ui`;
    g.fillText(hi.toFixed(2), 4, 12 * devicePixelRatio);
    g.fillText(lo.toFixed(2), 4, H - 4);
  };

  let lastText = 0;
  sim.onReadout = (r: SimReadout) => {
    const now = performance.now();
    if (sim.running && now - lastSample > 50) {
      lastSample = now;
      history.push(r.tendonLength.map((v) => v * 1000));
      if (history.length > 240) history.shift();
      draw();
    }
    if (now - lastText < 100) return;
    lastText = now;
    const rows: [string, string][] = [
      ["time", `${r.time.toFixed(3)} s`],
      ["real-time", sim.running ? `${r.realtime.toFixed(2)}×` : "paused"],
      ["step", `${(r.stepMs * 1000).toFixed(1)} µs`],
      ["contacts", String(r.ncon)],
      ["tip (mm)", r.tip ? r.tip.map((v) => (v * 1000).toFixed(1)).join(", ") : "—"],
      ...r.tendonLength.map((v, i) => [`tendon${i + 1}`, `${(v * 1000).toFixed(2)} mm  F=${(r.actuatorForce[i] ?? 0).toFixed(2)}`] as [string, string]),
    ];
    if (r.warnings.length) rows.push(["warnings", r.warnings.join(", ")]);
    const jd = r.jointDeg;
    if (jd.length) rows.push(["joints (°)", jd.map((v) => v.toFixed(1)).join(" ")]);
    readout.replaceChildren(...rows.flatMap(([k, v]) => [el("span", { class: "k" }, k), el("span", { class: "v mono" }, v)]));
  };

  const root = el("div", { class: "sim-tab" }, toolbar, el("div", { class: "sim-body" }, el("div", { class: "view-wrap" }, viewHost, overlay), side));

  const panel: SimPanel = {
    root,
    sim,
    async load(xml, assets, label) {
      const wasRunning = sim.running;
      try {
        overlay.textContent = "Loading MuJoCo…";
        overlay.hidden = false;
        await sim.load(xml, assets);
        title.textContent = label;
        overlay.hidden = true;
        history.length = 0;
        buildActuators();
        stale.hidden = true;
        setRunning(wasRunning || true);
      } catch (e) {
        overlay.textContent = (e as Error).message;
        overlay.hidden = false;
        log.error((e as Error).message);
        throw e;
      }
    },
    markStale(s) {
      stale.hidden = !s || !sim.loaded;
    },
  };
  return panel;
}

function checkbox(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const i = el("input", { type: "checkbox" });
  i.checked = value;
  i.addEventListener("change", () => onChange(i.checked));
  return el("label", { class: "check" }, i, label);
}
