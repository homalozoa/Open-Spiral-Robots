// In-browser MuJoCo (official @mujoco/mujoco WASM build): loads the exported
// robot.xml + baselink.stl, steps it in real time and renders it with three.js.
// This is the web counterpart of opening robot.xml in MuJoCo's viewer.

import * as THREE from "three";
import type { MainModule, MjData, MjModel, MjVFS } from "@mujoco/mujoco";
import wasmUrl from "@mujoco/mujoco/mujoco.wasm?url";
import { disposeObject, Viewport } from "../ui/viewport";

type Mujoco = MainModule;

let modulePromise: Promise<Mujoco> | null = null;
export function loadMujocoModule(): Promise<Mujoco> {
  modulePromise ??= import("@mujoco/mujoco").then((m) => m.default({ locateFile: () => wasmUrl }) as Promise<Mujoco>);
  return modulePromise;
}

export interface ActuatorInfo {
  name: string;
  lo: number;
  hi: number;
}

export interface JointInfo {
  name: string;
  type: number; // mjtJoint: 0 free, 1 ball, 2 slide, 3 hinge
  qposadr: number;
}

export interface SimReadout {
  time: number;
  realtime: number;
  stepMs: number;
  ncon: number;
  tendonLength: number[];
  actuatorForce: number[];
  jointDeg: number[];
  tip: [number, number, number] | null;
  warnings: string[];
}

const GEOM_PLANE = 0;
const GEOM_MESH = 7;

export class Simulator {
  readonly vp: Viewport;
  private mj: Mujoco | null = null;
  private model: MjModel | null = null;
  private data: MjData | null = null;
  private vfs: MjVFS | null = null;
  private scene = new THREE.Group();
  private geomObjs: { g: number; obj: THREE.Object3D }[] = [];
  private siteMesh: THREE.InstancedMesh | null = null;
  private tendonLines: THREE.Line[] = [];
  actuators: ActuatorInfo[] = [];
  joints: JointInfo[] = [];
  tendons: string[] = [];
  running = false;
  speed = 1;
  showSites = true;
  showTendons = true;
  private stepMs = 0;
  private realtime = 0;
  private tipBody = -1;
  onReadout: ((r: SimReadout) => void) | null = null;
  private log: (level: "info" | "warn" | "error", msg: string) => void;

  constructor(host: HTMLElement, log: Simulator["log"]) {
    this.log = log;
    this.vp = new Viewport(host);
    this.vp.root.add(this.scene);
    this.vp.onFrame = (dt) => this.frame(dt);
  }

  get loaded(): boolean {
    return !!this.model;
  }

  async load(xml: string, assets: Record<string, Uint8Array>): Promise<void> {
    const mj = (this.mj ??= await loadMujocoModule());
    this.unload();
    const vfs = new mj.MjVFS();
    for (const [name, bytes] of Object.entries(assets)) vfs.addBuffer(name, bytes);
    let model: MjModel;
    try {
      model = mj.MjModel.from_xml_string(xml, vfs);
    } catch (e) {
      vfs.delete();
      const msg = typeof e === "number" ? describeWasmException(mj, e) : (e as Error).message ?? String(e);
      throw new Error(`MuJoCo could not compile the model: ${msg}`);
    }
    this.vfs = vfs;
    this.model = model;
    this.data = new mj.MjData(model);
    mj.mj_forward(model, this.data);

    this.actuators = [];
    const cr = model.actuator_ctrlrange as Float64Array;
    for (let i = 0; i < model.nu; i++) {
      const a = model.actuator(i);
      this.actuators.push({ name: a.name || `act${i + 1}`, lo: cr[2 * i], hi: cr[2 * i + 1] });
      a.delete();
    }
    this.joints = [];
    const jt = model.jnt_type as Int32Array;
    const jq = model.jnt_qposadr as Int32Array;
    for (let i = 0; i < model.njnt; i++) {
      const j = model.jnt(i);
      this.joints.push({ name: j.name || `j${i + 1}`, type: jt[i], qposadr: jq[i] });
      j.delete();
    }
    this.tendons = [];
    for (let i = 0; i < model.ntendon; i++) {
      const t = model.tendon(i);
      this.tendons.push(t.name || `tendon${i + 1}`);
      t.delete();
    }
    this.tipBody = model.nbody - 1;
    this.buildScene();
    this.log("info", `MuJoCo model: ${model.nbody - 1} bodies, ${model.njnt} joints, ${model.ntendon} tendons, ${model.nu} actuators, timestep ${model.opt.timestep}s`);
    this.syncScene();
    this.resetView();
  }

  unload(): void {
    this.running = false;
    disposeObject(this.scene);
    this.scene.clear();
    this.geomObjs = [];
    this.tendonLines = [];
    this.siteMesh = null;
    this.data?.delete();
    this.model?.delete();
    this.vfs?.delete();
    this.data = null;
    this.model = null;
    this.vfs = null;
  }

  private buildScene(): void {
    const m = this.model!;
    const types = m.geom_type as Int32Array;
    const dataid = m.geom_dataid as Int32Array;
    const rgba = m.geom_rgba as Float32Array;
    const vert = m.mesh_vert as Float32Array;
    const face = m.mesh_face as Int32Array;
    const vadr = m.mesh_vertadr as Int32Array;
    const vnum = m.mesh_vertnum as Int32Array;
    const fadr = m.mesh_faceadr as Int32Array;
    const fnum = m.mesh_facenum as Int32Array;
    const meshGeo = new Map<number, THREE.BufferGeometry>();
    let robotGeoms = 0;
    for (let g = 0; g < m.ngeom; g++) {
      if (types[g] === GEOM_PLANE) {
        const grid = new THREE.Group();
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(2, 2),
          new THREE.MeshStandardMaterial({ color: 0x2a3a4c, roughness: 0.9, transparent: true, opacity: 0.85 }),
        );
        grid.add(plane);
        const helper = new THREE.GridHelper(2, 80, 0x8899aa, 0x56677a);
        helper.rotation.x = Math.PI / 2;
        helper.position.z = 1e-4;
        grid.add(helper);
        this.scene.add(grid);
        this.geomObjs.push({ g, obj: grid });
        continue;
      }
      if (types[g] !== GEOM_MESH) continue;
      const id = dataid[g];
      let geo = meshGeo.get(id);
      if (!geo) {
        geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(vert.slice(3 * vadr[id], 3 * (vadr[id] + vnum[id])), 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint32Array(face.slice(3 * fadr[id], 3 * (fadr[id] + fnum[id]))), 1));
        geo.computeVertexNormals();
        meshGeo.set(id, geo);
      }
      const shade = robotGeoms++ % 2 ? 0x7fb2e0 : 0x9cc6ec;
      const isDefault = rgba[4 * g] === 0.5 && rgba[4 * g + 1] === 0.5 && rgba[4 * g + 2] === 0.5;
      const color = isDefault ? new THREE.Color(shade) : new THREE.Color(rgba[4 * g], rgba[4 * g + 1], rgba[4 * g + 2]);
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.05, side: THREE.DoubleSide, flatShading: true }),
      );
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.geomObjs.push({ g, obj: mesh });
    }
    if (m.nsite > 0) {
      const size = m.site_size as Float64Array;
      const r = Math.max(1e-4, size[0]);
      this.siteMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd23f }), m.nsite);
      this.scene.add(this.siteMesh);
    }
    const tendonColors = [0xe63333, 0x3399e6, 0x33b847, 0xf29e1a, 0x9e42d9, 0x1ab8b3, 0xe052ad, 0x737373];
    for (let t = 0; t < m.ntendon; t++) {
      const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: tendonColors[t % tendonColors.length], depthTest: false }));
      line.renderOrder = 10;
      this.tendonLines.push(line);
      this.scene.add(line);
    }
  }

  private syncScene(): void {
    const m = this.model;
    const d = this.data;
    if (!m || !d) return;
    const xpos = d.geom_xpos as Float64Array;
    const xmat = d.geom_xmat as Float64Array;
    const mat = new THREE.Matrix4();
    for (const { g, obj } of this.geomObjs) {
      const r = xmat.subarray(9 * g, 9 * g + 9);
      mat.set(r[0], r[1], r[2], xpos[3 * g], r[3], r[4], r[5], xpos[3 * g + 1], r[6], r[7], r[8], xpos[3 * g + 2], 0, 0, 0, 1);
      if (obj.matrixAutoUpdate) {
        obj.position.set(xpos[3 * g], xpos[3 * g + 1], xpos[3 * g + 2]);
      } else {
        obj.matrix.copy(mat);
        obj.matrixWorldNeedsUpdate = true;
      }
    }
    if (this.siteMesh) {
      this.siteMesh.visible = this.showSites;
      const sx = d.site_xpos as Float64Array;
      const t = new THREE.Matrix4();
      for (let i = 0; i < m.nsite; i++) {
        t.makeTranslation(sx[3 * i], sx[3 * i + 1], sx[3 * i + 2]);
        this.siteMesh.setMatrixAt(i, t);
      }
      this.siteMesh.instanceMatrix.needsUpdate = true;
    }
    const wadr = d.ten_wrapadr as Int32Array;
    const wnum = d.ten_wrapnum as Int32Array;
    const wobj = d.wrap_obj as Int32Array;
    const wxp = d.wrap_xpos as Float64Array;
    this.tendonLines.forEach((line, t) => {
      line.visible = this.showTendons;
      const pts: number[] = [];
      for (let j = 0; j < wnum[t]; j++) {
        const k = wadr[t] + j;
        if (wobj[k] === -2) continue; // pulley
        pts.push(wxp[3 * k], wxp[3 * k + 1], wxp[3 * k + 2]);
      }
      line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      line.geometry.computeBoundingSphere();
    });
  }

  private frame(dt: number): void {
    const mj = this.mj;
    const m = this.model;
    const d = this.data;
    if (!mj || !m || !d) return;
    if (this.running) {
      const target = Math.min(dt, 1 / 20) * this.speed;
      const ts = m.opt.timestep;
      const n = Math.min(4000, Math.max(1, Math.round(target / ts)));
      const t0 = performance.now();
      for (let i = 0; i < n; i++) mj.mj_step(m, d);
      const spent = performance.now() - t0;
      this.stepMs = spent / n;
      this.realtime = dt > 0 ? (n * ts) / dt : 0;
      if (!d.qpos || !(d.qpos as Float64Array).every(Number.isFinite)) {
        this.running = false;
        this.log("error", "Simulation diverged (NaN in qpos). Lower the gear / stiffness or reset.");
      }
      this.syncScene();
    }
    this.onReadout?.(this.readout());
  }

  readout(): SimReadout {
    const m = this.model;
    const d = this.data;
    if (!m || !d) return { time: 0, realtime: 0, stepMs: 0, ncon: 0, tendonLength: [], actuatorForce: [], jointDeg: [], tip: null, warnings: [] };
    const qpos = d.qpos as Float64Array;
    const jointDeg = this.joints.map((j) => {
      if (j.type === 3) return (qpos[j.qposadr] * 180) / Math.PI;
      if (j.type === 1) {
        const w = Math.min(1, Math.abs(qpos[j.qposadr]));
        return (2 * Math.acos(w) * 180) / Math.PI;
      }
      return qpos[j.qposadr];
    });
    const xpos = d.xpos as Float64Array;
    const tb = this.tipBody;
    const warnings = this.warnings();
    return {
      time: d.time,
      realtime: this.running ? this.realtime : 0,
      stepMs: this.stepMs,
      ncon: d.ncon,
      tendonLength: Array.from(d.ten_length as Float64Array),
      actuatorForce: Array.from(d.actuator_force as Float64Array),
      jointDeg,
      tip: tb > 0 ? [xpos[3 * tb], xpos[3 * tb + 1], xpos[3 * tb + 2]] : null,
      warnings,
    };
  }

  private lastWarn = 0;
  private warnCache: string[] = [];
  /** Non-zero mjWarningStat counters (data.warning is a view into mjData: never delete it). */
  private warnings(): string[] {
    const d = this.data;
    if (!d) return [];
    const now = performance.now();
    if (now - this.lastWarn < 500) return this.warnCache;
    this.lastWarn = now;
    const names = ["INERTIA", "CONTACTFULL", "CNSTRFULL", "VGEOMFULL", "BADQPOS", "BADQVEL", "BADQACC", "BADCTRL"];
    const out: string[] = [];
    const w = d.warning;
    for (let i = 0; i < Math.min(w.size(), names.length); i++) {
      const n = w.get(i)?.number ?? 0;
      if (n > 0) out.push(`${names[i]} ×${n}`);
    }
    this.warnCache = out;
    return out;
  }

  setCtrl(i: number, v: number): void {
    if (!this.data) return;
    (this.data.ctrl as Float64Array)[i] = v;
  }

  getCtrl(): number[] {
    return this.data ? Array.from(this.data.ctrl as Float64Array) : [];
  }

  step(n = 1): void {
    if (!this.mj || !this.model || !this.data) return;
    for (let i = 0; i < n; i++) this.mj.mj_step(this.model, this.data);
    this.syncScene();
    this.vp.invalidate();
  }

  reset(): void {
    if (!this.mj || !this.model || !this.data) return;
    const ctrl = this.getCtrl();
    this.mj.mj_resetData(this.model, this.data);
    ctrl.forEach((v, i) => this.setCtrl(i, v));
    this.mj.mj_forward(this.model, this.data);
    this.syncScene();
    this.vp.invalidate();
  }

  setGravity(g: number): void {
    if (!this.model) return;
    const grav = this.model.opt.gravity as Float64Array;
    grav[2] = -g;
  }

  resetView(): void {
    const box = new THREE.Box3();
    for (const { obj } of this.geomObjs) {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.computeBoundingBox();
        box.union(obj.geometry.boundingBox!.clone().applyMatrix4(obj.matrix));
      }
    }
    this.vp.camera.position.set(0.8, -1, 0.5);
    this.vp.controls.target.set(0, 0, 0);
    this.vp.fit(box, true);
  }
}

function describeWasmException(mj: Mujoco, ptr: number): string {
  try {
    // emscripten C++ exception pointer -> message, when the build exposes it
    const anyMj = mj as unknown as { getExceptionMessage?: (p: number) => [string, string] };
    if (anyMj.getExceptionMessage) return anyMj.getExceptionMessage(ptr).join(": ");
  } catch {
    /* fall through */
  }
  return `native exception ${ptr}`;
}
