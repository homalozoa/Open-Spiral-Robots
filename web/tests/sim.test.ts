// MuJoCo WASM smoke test: the generated XML + an STL mesh load and step.
import { describe, expect, it } from "vitest";
import loadMujoco from "@mujoco/mujoco";
import { meshToBinarySTL } from "../src/core/files";
import { generateMujocoXml } from "../src/core/xml";

function boxStl(sx: number, sy: number, sz: number): Uint8Array {
  const v = [0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz].map((x, i) =>
    i % 3 === 0 ? x - sx / 2 : i % 3 === 1 ? x - sy / 2 : x,
  );
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return meshToBinarySTL([{ vertices: v, triangles: t }]);
}

describe("MuJoCo", () => {
  it("loads and steps the generated chain", async () => {
    const mj = await loadMujoco();
    const xml = generateMujocoXml({
      stlName: "baselink.stl", unitHeight: 10, scale: 1.1, numUnits: 5, jointType: "hinge",
      jointLimitDeg: 30, robotLength: 60, sitePoints: [50, 3, 60, 4], cableMode: 2,
      jointStiffness: 5, jointDamping: 0.2, gravity: 9.81, jointAngles: [4, 4, 4, 4],
    });
    const vfs = new mj.MjVFS();
    vfs.addBuffer("baselink.stl", boxStl(12, 12, 10));
    const model = mj.MjModel.from_xml_string(xml, vfs);
    expect(model.nu).toBe(2);
    expect(model.ntendon).toBe(2);
    const run = (ctrl: number) => {
      const data = new mj.MjData(model);
      data.ctrl[0] = ctrl;
      for (let i = 0; i < 300; i++) mj.mj_step(model, data);
      const q = Array.from(data.qpos as Float64Array);
      data.delete();
      return q;
    };
    const q0 = run(0);
    const q1 = run(1);
    expect(q1.every(Number.isFinite)).toBe(true);
    // pulling tendon 1 changes the pose relative to the passive run
    expect(Math.abs(q1[0] - q0[0])).toBeGreaterThan(1e-4);
    const act = model.actuator(0);
    expect(act.name).toBe("act1");
    act.delete();
    expect(model.nmesh).toBe(5);
    model.delete();
    vfs.delete();
  }, 60_000);
});
