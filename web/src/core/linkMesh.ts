// Procedural mesh of the base link, in the frame the MuJoCo XML expects
// (millimetres, chain along +Z from the base face at z = 0): the plain unit
// body without holes or cone cuts. It is what the live showcase simulates and
// draws; it takes well under a millisecond, so the model can be rebuilt on
// every slider move. The exact OpenCascade solid is only used for exports.

import type { Design, Pt } from "./design";
import type { Params } from "./params";

export interface LinkMesh {
  vertices: Float32Array;
  triangles: Uint32Array;
}

function convexHull(points: Pt[]): Pt[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1)); // counter-clockwise
}

/** CAD (x along the chain, y width, z thickness) -> XML frame. */
const toXml = (L: number, x: number, y: number, z: number): [number, number, number] => [z, y, L - x];

export function baseLinkMesh(design: Design, params: Params, segments = 40): LinkMesh {
  const L = design.length;
  const last = design.primary[design.primary.length - 1];
  const verts: number[] = [];
  const tris: number[] = [];
  const add = (x: number, y: number, z: number) => {
    const [a, b, c] = toXml(L, x, y, z);
    verts.push(a, b, c);
    return verts.length / 3 - 1;
  };

  if (params.two_cable) {
    const mirror = design.mirror[design.mirror.length - 1];
    const outline = convexHull([...last, ...mirror]);
    const t = Math.max(0.1, params.extrusion) / 2;
    const n = outline.length;
    const top = outline.map(([x, y]) => add(x, y, t));
    const bot = outline.map(([x, y]) => add(x, y, -t));
    for (let i = 1; i + 1 < n; i++) {
      tris.push(top[0], top[i], top[i + 1]);
      tris.push(bot[0], bot[i + 1], bot[i]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      tris.push(bot[i], bot[j], top[j], bot[i], top[j], top[i]);
    }
  } else {
    // revolve the unit profile (y >= 0) about the chain axis
    const prof = convexHull(last.map(([x, y]) => [x, Math.max(0, y)] as Pt));
    const rings = prof.map(([x, r]) =>
      Array.from({ length: segments }, (_, k) => {
        const phi = (2 * Math.PI * k) / segments;
        return add(x, r * Math.cos(phi), r * Math.sin(phi));
      }),
    );
    for (let i = 0; i < prof.length; i++) {
      const j = (i + 1) % prof.length;
      if (prof[i][1] < 1e-9 && prof[j][1] < 1e-9) continue;
      for (let k = 0; k < segments; k++) {
        const k2 = (k + 1) % segments;
        const [a, b, c, d] = [rings[i][k], rings[i][k2], rings[j][k2], rings[j][k]];
        if (prof[i][1] >= 1e-9) tris.push(a, b, c);
        if (prof[j][1] >= 1e-9) tris.push(a, c, d);
      }
    }
  }
  const mesh = { vertices: new Float32Array(verts), triangles: new Uint32Array(tris) };
  // outward-facing triangles (positive volume) for correct lighting
  if (meshVolume(mesh) < 0) {
    for (let i = 0; i < mesh.triangles.length; i += 3) {
      const t = mesh.triangles[i + 1];
      mesh.triangles[i + 1] = mesh.triangles[i + 2];
      mesh.triangles[i + 2] = t;
    }
  }
  return mesh;
}

/** Signed volume (mm³) of a closed triangle mesh. */
export function meshVolume(m: LinkMesh): number {
  const v = m.vertices;
  let vol = 0;
  for (let i = 0; i < m.triangles.length; i += 3) {
    const a = m.triangles[i] * 3, b = m.triangles[i + 1] * 3, c = m.triangles[i + 2] * 3;
    vol +=
      (v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
        v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
        v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c])) / 6;
  }
  return vol;
}
