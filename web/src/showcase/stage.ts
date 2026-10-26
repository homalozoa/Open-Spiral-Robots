// Full-bleed three.js stage for the showcase: the live robot, tendons,
// tip trail, stroboscopic ghosts, scene object, scale references and the
// pointer interactions (grab the robot, drag the object).

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LinkMesh } from "../core/linkMesh";
import type { ObjectKind } from "./physics";
import type { Frame, WorkerMeta } from "./protocol";

export const TENDON_HEX = [0xff5a4f, 0x3ea6ff, 0x3ccf6e, 0xffb020, 0xb06bff, 0x22d3c5, 0xff6fb5, 0x9aa3ad];

const BASE = new THREE.Color(0x8fc3ec);
const WARM = new THREE.Color(0xff8a3d);

export interface StageTheme {
  dark: boolean;
}

export type PickHit = { kind: "link"; index: number; point: THREE.Vector3 } | { kind: "object"; point: THREE.Vector3 };

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(32, 1, 0.001, 1000);
  readonly controls: OrbitControls;
  private robot = new THREE.Group();
  private links: THREE.Mesh[] = [];
  private linkMats: THREE.MeshPhysicalMaterial[] = [];
  private linkGeo: THREE.BufferGeometry | null = null;
  private edgeGeo: THREE.BufferGeometry | null = null;
  private tendons: Line2[] = [];
  private trail: Line2;
  private trailPts: number[] = [];
  private trailSpeed: number[] = [];
  private ghosts = new THREE.Group();
  private refs = new THREE.Group();
  private object: THREE.Mesh | null = null;
  private objectKind: ObjectKind = "none";
  private mount = new THREE.Group();
  private ground: THREE.Mesh;
  private grid: THREE.Mesh | null = null;
  private grabLine: Line2;
  private sun: THREE.DirectionalLight;
  private meta: WorkerMeta | null = null;
  private autoFrame = true;
  /** screen area (px) not covered by floating panels */
  private safe = { left: 0, top: 0, right: 0, bottom: 0 };
  private observer: ResizeObserver;
  readonly labels: HTMLElement;
  private labelItems: { el: HTMLElement; pos: THREE.Vector3 }[] = [];
  heat = true;
  showEdges = true;
  showTrail = true;
  showTendons = true;
  fps = 60;
  onBeforeRender: ((dt: number) => void) | null = null;

  constructor(readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    host.appendChild(this.renderer.domElement);
    this.labels = document.createElement("div");
    this.labels.className = "stage-labels";
    host.appendChild(this.labels);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0.25, -1.3, 0.5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener("start", () => {
      this.autoFrame = false;
    });

    this.scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x2a2f38, 0.9));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    const rim = new THREE.DirectionalLight(0x9cc8ff, 0.9);
    rim.position.set(-1, 1.5, 0.6);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22 }));
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.robot, this.ghosts, this.refs, this.mount);

    this.trail = new Line2(new LineGeometry(), new LineMaterial({ linewidth: 2.5, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);
    this.grabLine = new Line2(new LineGeometry(), new LineMaterial({ color: 0xffd23f, linewidth: 2, dashed: false, depthTest: false }));
    this.grabLine.renderOrder = 20;
    this.grabLine.visible = false;
    this.grabLine.frustumCulled = false;
    this.scene.add(this.grabLine);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    let last = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this.fps = this.fps * 0.92 + (dt > 0 ? 1 / dt : 60) * 0.08;
      this.onBeforeRender?.(dt);
      this.updateCamera(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    };
    loop();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.camera.aspect = w / h;
    this.applyViewOffset();
    this.camera.updateProjectionMatrix();
    const res = new THREE.Vector2(w, h);
    for (const l of [...this.tendons, this.trail, this.grabLine]) (l.material as LineMaterial).resolution.copy(res);
  }

  // ---------------------------------------------------------------- robot
  setRobot(meta: WorkerMeta, mesh: LinkMesh): void {
    this.meta = meta;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.triangles, 1));
    geo.computeVertexNormals();
    const edges = new THREE.EdgesGeometry(geo, 28);
    this.linkGeo?.dispose();
    this.edgeGeo?.dispose();
    this.linkGeo = geo;
    this.edgeGeo = edges;
    for (const m of this.linkMats) m.dispose();
    this.robot.clear();
    this.links = [];
    this.linkMats = [];
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x14324d, transparent: true, opacity: 0.35 });
    meta.linkScale.forEach((s) => {
      const mat = new THREE.MeshPhysicalMaterial({
        color: BASE,
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.6,
        clearcoatRoughness: 0.35,
        sheen: 0.4,
        sheenColor: new THREE.Color(0xcfe8ff),
        side: THREE.DoubleSide,
        flatShading: true,
      });
      const link = new THREE.Mesh(geo, mat);
      link.castShadow = true;
      link.receiveShadow = true;
      link.scale.setScalar(0.001 * s);
      link.matrixAutoUpdate = true;
      const e = new THREE.LineSegments(edges, edgeMat);
      e.visible = this.showEdges;
      link.add(e);
      link.userData.index = this.links.length;
      this.robot.add(link);
      this.links.push(link);
      this.linkMats.push(mat);
    });
    // tendons
    for (const t of this.tendons) {
      t.geometry.dispose();
      (t.material as LineMaterial).dispose();
      this.scene.remove(t);
    }
    this.tendons = Array.from({ length: meta.nu }, (_, i) => {
      const l = new Line2(new LineGeometry(), new LineMaterial({ color: TENDON_HEX[i % TENDON_HEX.length], linewidth: 2.2, transparent: true, opacity: 0.95, depthTest: true }));
      l.frustumCulled = false;
      (l.material as LineMaterial).resolution.set(this.host.clientWidth, this.host.clientHeight);
      this.scene.add(l);
      return l;
    });
    this.buildEnvironment(meta);
    this.clearTrail();
  }

  private buildEnvironment(meta: WorkerMeta): void {
    const L = meta.lengthM;
    // ground + adaptive grid
    this.ground.scale.setScalar(L * 12);
    this.ground.position.set(L * 0.5, 0, 0);
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.scene.remove(this.grid);
    }
    this.grid = makeGrid(L, this.dark);
    this.scene.add(this.grid);

    // wall mount at the base
    this.mount.clear();
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.35, metalness: 0.8 });
    const bs = Math.max(L * 0.1, 0.004);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(bs * 0.12, bs * 1.6, bs * 1.6), metal);
    plate.position.set(meta.mount[0] - bs * 0.06, meta.mount[1], meta.mount[2]);
    const post = new THREE.Mesh(new THREE.BoxGeometry(bs * 0.5, bs * 0.5, meta.mount[2]), metal);
    post.position.set(meta.mount[0] - bs * 0.35, meta.mount[1], meta.mount[2] / 2);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(bs * 1.4, bs * 1.4, bs * 0.12), metal);
    foot.position.set(meta.mount[0] - bs * 0.35, meta.mount[1], bs * 0.06);
    for (const m of [plate, post, foot]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.mount.add(m);
    }

    // light + shadow camera sized to the robot
    this.sun.position.set(meta.mount[0] + L * 0.4, -L * 0.8, L * 2.2);
    this.sun.target.position.set(L * 0.5, 0, 0);
    const sc = this.sun.shadow.camera;
    sc.left = -L * 1.6;
    sc.right = L * 1.6;
    sc.top = L * 1.6;
    sc.bottom = -L * 1.6;
    sc.near = L * 0.1;
    sc.far = L * 6;
    sc.updateProjectionMatrix();

    this.viewBox = null;
  }

  private dark = matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(dark: boolean): void {
    this.dark = dark;
    if (this.meta) this.buildEnvironment(this.meta);
  }

  /** Apply a simulation frame (or a replayed pose). */
  applyPoses(poses: Float32Array, bends?: Float32Array): void {
    const n = Math.min(this.links.length, poses.length / 7);
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      const l = this.links[i];
      l.position.set(poses[o], poses[o + 1], poses[o + 2]);
      l.quaternion.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]);
    }
    this.colorize(bends);
  }

  private colorize(bends?: Float32Array): void {
    const lim = Math.max(1, this.meta?.jointLimitDeg ?? 30);
    this.linkMats.forEach((m, i) => {
      if (!this.heat || !bends) {
        m.color.copy(BASE);
        return;
      }
      // a link is coloured by the bend of the joint at its base side
      const b = i === 0 ? 0 : Math.abs(bends[i - 1] ?? 0);
      const t = Math.min(1, b / lim);
      m.color.copy(BASE).lerp(WARM, t * t * (3 - 2 * t));
    });
  }

  applyFrame(f: Frame): void {
    this.applyPoses(f.poses, f.bends);
    f.tendons.forEach((pts, i) => {
      const line = this.tendons[i];
      if (!line) return;
      line.visible = this.showTendons && pts.length >= 6;
      if (line.visible) {
        line.geometry.dispose();
        line.geometry = new LineGeometry();
        line.geometry.setPositions(Array.from(pts));
      }
    });
    if (f.grab) {
      this.grabLine.visible = true;
      this.grabLine.geometry.setPositions([...f.grab.from, ...f.grab.to]);
    } else {
      this.grabLine.visible = false;
    }
  }

  // ---------------------------------------------------------------- trail
  clearTrail(): void {
    this.trailBox = [];
    this.trailPts = [];
    this.trailSpeed = [];
    this.trail.visible = false;
  }

  pushTrail(tip: [number, number, number], speed: number, vmax: number): void {
    if (!this.showTrail) {
      this.trail.visible = false;
      return;
    }
    const n = this.trailPts.length;
    if (n >= 3) {
      const d = Math.hypot(tip[0] - this.trailPts[n - 3], tip[1] - this.trailPts[n - 2], tip[2] - this.trailPts[n - 1]);
      if (d < (this.meta?.lengthM ?? 0.4) * 0.002) return;
    }
    this.trailPts.push(...tip);
    this.trailSpeed.push(speed);
    if (this.trailPts.length > 3 * 600) {
      this.trailPts.splice(0, 3);
      this.trailSpeed.shift();
    }
    this.setTrail(this.trailPts, this.trailSpeed, vmax);
  }

  setTrail(pts: ArrayLike<number>, speed: ArrayLike<number>, vmax: number): void {
    if (pts.length < 6) {
      this.trail.visible = false;
      return;
    }
    const colors: number[] = [];
    const slow = new THREE.Color(0x3ea6ff);
    const fast = new THREE.Color(0xffd23f);
    const c = new THREE.Color();
    for (let i = 0; i < speed.length; i++) {
      c.copy(slow).lerp(fast, Math.min(1, speed[i] / Math.max(1e-6, vmax)));
      colors.push(c.r, c.g, c.b);
    }
    this.trailBox = Array.from(pts);
    this.trail.geometry.dispose();
    const g = new LineGeometry();
    g.setPositions(this.trailBox);
    g.setColors(colors);
    this.trail.geometry = g;
    this.trail.visible = true;
  }

  // ---------------------------------------------------------------- ghosts
  setGhosts(list: Float32Array[]): void {
    this.ghosts.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose();
    });
    this.ghosts.clear();
    if (!this.linkGeo || !this.meta) return;
    list.forEach((poses, k) => {
      const t = list.length > 1 ? k / (list.length - 1) : 1;
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x3ea6ff).lerp(new THREE.Color(0xffd23f), t),
        transparent: true,
        opacity: 0.12 + 0.28 * t,
        depthWrite: false,
        roughness: 0.6,
        flatShading: true,
      });
      for (let i = 0; i < poses.length / 7; i++) {
        const o = i * 7;
        const g = new THREE.Mesh(this.linkGeo!, mat);
        g.scale.setScalar(0.001 * this.meta!.linkScale[i]);
        g.position.set(poses[o], poses[o + 1], poses[o + 2]);
        g.quaternion.set(poses[o + 4], poses[o + 5], poses[o + 6], poses[o + 3]);
        this.ghosts.add(g);
      }
    });
  }

  // ---------------------------------------------------------------- object
  setObject(kind: ObjectKind, sizeM: number, pos: [number, number, number], lengthM: number): void {
    if (this.object) {
      this.object.geometry.dispose();
      (this.object.material as THREE.Material).dispose();
      this.scene.remove(this.object);
      this.object = null;
    }
    this.objectKind = kind;
    if (kind === "none") return;
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xf2c14e, roughness: 0.3, metalness: 0.1, clearcoat: 0.8 });
    const geo =
      kind === "cylinder"
        ? new THREE.CylinderGeometry(sizeM / 2, sizeM / 2, 0.6 * lengthM, 48)
        : kind === "sphere"
          ? new THREE.SphereGeometry(sizeM / 2, 48, 32)
          : new THREE.BoxGeometry(sizeM, sizeM, sizeM);
    this.object = new THREE.Mesh(geo, mat);
    this.object.castShadow = true;
    this.object.receiveShadow = true;
    this.object.position.set(...pos);
    this.scene.add(this.object);
  }

  moveObject(pos: [number, number, number]): void {
    this.object?.position.set(...pos);
  }

  // ---------------------------------------------------------------- scale references
  setReferences(kinds: Set<"coin" | "hand" | "human">, lengthM: number): void {
    this.refs.traverse((o) => {
      (o as THREE.Mesh).geometry?.dispose();
      ((o as THREE.Mesh).material as THREE.Material | undefined)?.dispose();
    });
    this.refs.clear();
    this.labelItems.forEach((l) => l.el.remove());
    this.labelItems = [];
    // in the robot's plane, standing on the ground to the right of its reach
    const y = 0;
    let x = lengthM * 1.2;
    const add = (obj: THREE.Object3D, width: number, height: number, label: string) => {
      obj.position.x = x + width / 2;
      obj.position.y = y;
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      this.refs.add(obj);
      this.label(label, new THREE.Vector3(x + width / 2, y, height * 1.08 + lengthM * 0.02));
      x += width + Math.max(0.01, lengthM * 0.15);
    };
    const skin = new THREE.MeshStandardMaterial({ color: 0xe0b393, roughness: 0.7 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x55657a, roughness: 0.8 });
    if (kinds.has("coin")) {
      // standing on its edge, face toward the camera
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.0121, 0.0121, 0.0019, 64), new THREE.MeshStandardMaterial({ color: 0xd9b45a, metalness: 0.9, roughness: 0.25 }));
      coin.position.z = 0.0121;
      const g = new THREE.Group();
      g.add(coin);
      add(g, 0.0242, 0.0242, "Coin · 24 mm");
    }
    if (kinds.has("hand")) {
      const g = new THREE.Group();
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.022, 0.1), skin);
      palm.position.z = 0.05;
      g.add(palm);
      const fingers = [[-0.03, 0.075], [-0.01, 0.085], [0.01, 0.08], [0.03, 0.065]];
      for (const [fx, fl] of fingers) {
        const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, fl - 0.018, 6, 12), skin);
        f.position.set(fx, 0, 0.1 + fl / 2);
        g.add(f);
      }
      const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.01, 0.045, 6, 12), skin);
      thumb.position.set(-0.052, 0, 0.065);
      thumb.rotation.y = 0.6;
      g.add(thumb);
      add(g, 0.1, 0.19, "Hand · 19 cm");
    }
    if (kinds.has("human")) {
      // a flat stand-up silhouette reads better than a stack of capsules
      const g = new THREE.Group();
      const sil = new THREE.Mesh(humanSilhouette(), cloth);
      sil.rotation.x = Math.PI / 2;
      sil.position.y = 0.01;
      g.add(sil);
      add(g, 0.54, 1.75, "Person · 1.75 m");
    }
    this.refsBox = this.refs.children.length ? new THREE.Box3().setFromObject(this.refs) : new THREE.Box3();
  }

  label(text: string, pos: THREE.Vector3): HTMLElement {
    const el = document.createElement("div");
    el.className = "stage-label";
    el.textContent = text;
    this.labels.appendChild(el);
    this.labelItems.push({ el, pos });
    return el;
  }

  private placeLabels(): void {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const v = new THREE.Vector3();
    for (const l of this.labelItems) {
      v.copy(l.pos).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
      l.el.style.display = visible ? "" : "none";
      l.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
    }
  }

  // ---------------------------------------------------------------- camera
  /** Resume automatic framing (after the user orbited the camera). */
  frame(_extra = 0, force = false): void {
    if (force) this.autoFrame = true;
  }

  /**
   * What the camera should keep in view: mount, live links, ghosts, trail and
   * scale references. Grows immediately, shrinks slowly, so the view follows
   * fast motion without pumping.
   */
  private targetBox(): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (!this.meta) return null;
    const L = this.meta.lengthM;
    const m = L * 0.1; // links extend about half a base width past their origin
    const box = { minX: -0.14 * L, maxX: 0.2 * L, minZ: 0, maxZ: this.meta.mount[2] + 0.12 * L };
    const add = (x: number, z: number) => {
      if (x - m < box.minX) box.minX = x - m;
      if (x + m > box.maxX) box.maxX = x + m;
      if (z - m < box.minZ) box.minZ = z - m;
      if (z + m > box.maxZ) box.maxZ = z + m;
    };
    for (const l of this.links) add(l.position.x, l.position.z);
    for (const g of this.ghosts.children) add(g.position.x, g.position.z);
    if (this.trail.visible) for (let i = 0; i + 2 < this.trailBox.length; i += 3) add(this.trailBox[i], this.trailBox[i + 2]);
    if (!this.refsBox.isEmpty()) {
      box.minX = Math.min(box.minX, this.refsBox.min.x);
      box.maxX = Math.max(box.maxX, this.refsBox.max.x);
      box.maxZ = Math.max(box.maxZ, this.refsBox.max.z * 1.12);
    }
    return box;
  }

  private viewBox: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  private trailBox: number[] = [];
  private refsBox = new THREE.Box3();

  setSafeArea(a: { left: number; top: number; right: number; bottom: number }): void {
    this.safe = a;
    this.applyViewOffset();
  }

  /** Shift the principal point to the centre of the safe area. */
  private applyViewOffset(): void {
    const W = Math.max(1, this.host.clientWidth);
    const H = Math.max(1, this.host.clientHeight);
    const { left, top, right, bottom } = this.safe;
    const cx = left + (W - left - right) / 2;
    const cy = top + (H - top - bottom) / 2;
    this.camera.setViewOffset(W, H, W / 2 - cx, H / 2 - cy, W, H);
  }

  private updateCamera(dt: number): void {
    if (!this.autoFrame) return;
    const target = this.targetBox();
    if (!target) return;
    if (!this.viewBox) this.viewBox = { ...target };
    const vb = this.viewBox;
    const grow = 1 - Math.exp(-dt * 8);
    const shrink = 1 - Math.exp(-dt * 0.7);
    vb.minX += (target.minX - vb.minX) * (target.minX < vb.minX ? grow : shrink);
    vb.minZ += (target.minZ - vb.minZ) * (target.minZ < vb.minZ ? grow : shrink);
    vb.maxX += (target.maxX - vb.maxX) * (target.maxX > vb.maxX ? grow : shrink);
    vb.maxZ += (target.maxZ - vb.maxZ) * (target.maxZ > vb.maxZ ? grow : shrink);
    const center = new THREE.Vector3((vb.minX + vb.maxX) / 2, 0, (vb.minZ + vb.maxZ) / 2);
    const hw = ((vb.maxX - vb.minX) / 2) * 1.06;
    const hh = ((vb.maxZ - vb.minZ) / 2) * 1.1;
    const W = Math.max(1, this.host.clientWidth);
    const H = Math.max(1, this.host.clientHeight);
    const sw = Math.max(80, W - this.safe.left - this.safe.right) / W;
    const sh = Math.max(80, H - this.safe.top - this.safe.bottom) / H;
    const vfov = (this.camera.fov * Math.PI) / 180;
    const tv = Math.tan(vfov / 2) * sh;
    const th = Math.tan(vfov / 2) * this.camera.aspect * sw;
    const dir = new THREE.Vector3(0.16, -1, 0.26).normalize();
    // the view is tilted, so the vertical extent needs a little extra room
    const dist = Math.max(hw / th, (hh * 1.08) / tv) + Math.abs(hw * dir.x);
    const want = center.clone().addScaledVector(dir, dist);
    const k = 1 - Math.exp(-dt * 5);
    this.controls.target.lerp(center, k);
    this.camera.position.lerp(want, k);
    this.camera.near = dist / 200;
    this.camera.far = dist * 50;
    this.camera.updateProjectionMatrix();
  }

  recenter(): void {
    this.autoFrame = true;
  }

  // ---------------------------------------------------------------- picking
  private ray = new THREE.Raycaster();
  pick(clientX: number, clientY: number): PickHit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const targets: THREE.Object3D[] = [...this.links];
    if (this.object) targets.push(this.object);
    const hit = this.ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    if (hit.object === this.object) return { kind: "object", point: hit.point.clone() };
    return { kind: "link", index: hit.object.userData.index as number, point: hit.point.clone() };
  }

  /** Point on the plane through `anchor` facing the camera, under the pointer. */
  dragPoint(clientX: number, clientY: number, anchor: THREE.Vector3, normal?: THREE.Vector3): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const n = normal ?? this.camera.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, anchor);
    return this.ray.ray.intersectPlane(plane, new THREE.Vector3());
  }

  setEdges(on: boolean): void {
    this.showEdges = on;
    for (const l of this.links) l.children.forEach((c) => (c.visible = on));
  }

  screenshot(): Promise<Blob> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((res, rej) => this.renderer.domElement.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
  }

  get objectType(): ObjectKind {
    return this.objectKind;
  }
}

/** Infinite-looking ground grid: minor/major lines that fade with distance. */
function makeGrid(L: number, dark: boolean): THREE.Mesh {
  const step = 10 ** Math.floor(Math.log10(L / 4));
  const size = L * 40;
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    extensions: { derivatives: true } as never,
    uniforms: {
      uStep: { value: step },
      uCenter: { value: new THREE.Vector2(L * 0.5, 0) },
      uFade: { value: L * 2.6 },
      uColor: { value: new THREE.Color(dark ? 0x9fb3cc : 0x5d7088) },
      uAlpha: { value: dark ? 0.55 : 0.45 },
    },
    vertexShader: `
      varying vec2 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xy;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform float uStep; uniform vec2 uCenter; uniform float uFade; uniform vec3 uColor; uniform float uAlpha;
      varying vec2 vW;
      float lines(vec2 p, float s) {
        vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = lines(vW, uStep) * 0.35;
        float major = lines(vW, uStep * 10.0);
        float d = length(vW - uCenter);
        float fade = 1.0 - smoothstep(uFade * 0.35, uFade, d);
        float a = max(minor, major) * fade * uAlpha;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.position.set(L * 0.5, 0, L * 1e-4);
  mesh.renderOrder = -1;
  return mesh;
}

/** 1.75 m human outline (metres, x across, y up), extruded 1.5 cm. */
function humanSilhouette(): THREE.ExtrudeGeometry {
  const right: [number, number][] = [
    [0.055, 1.52], [0.2, 1.46], [0.245, 1.38], [0.27, 0.86], [0.235, 0.83], [0.205, 1.25],
    [0.175, 1.0], [0.15, 0.92], [0.125, 0.08], [0.15, 0.0], [0.025, 0.0], [0.0, 0.8],
  ];
  const pts = [...right, ...right.slice(0, -1).reverse().map(([x, y]) => [-x, y] as [number, number])];
  const body = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const head = new THREE.Shape();
  head.absarc(0, 1.645, 0.105, 0, Math.PI * 2, false);
  return new THREE.ExtrudeGeometry([body, head], { depth: 0.015, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 32 });
}
