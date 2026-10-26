// Record the promo video (docs/promo.mp4): drive the built app in Chrome and
// save a screencast with timed marks, then cut it with cut.sh.
//
//   npm run build && npm run serve          # app on http://127.0.0.1:5180
//   npm i --no-save playwright-core
//   mkdir -p /tmp/promo && cd /tmp/promo
//   node <repo>/web/scripts/promo/capture.mjs && sh <repo>/web/scripts/promo/cut.sh
//
// Uses the installed Google Chrome (GPU, 1920x1080). PROMO_URL overrides the app URL.
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const URL_APP = process.env.PROMO_URL ?? "http://127.0.0.1:5180/";
const OUT = `${process.cwd()}/frames/`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
p.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
await p.goto(`${URL_APP}#m=flex&e=space`, { waitUntil: "load" });
await p.waitForFunction(() => window.osr, null, { timeout: 30000 });
await p.waitForTimeout(3000);
// warm the CAD drawer so the 3D model is ready when it opens
await p.evaluate(async () => { await osr.engineering(); await osr.build(); });
await p.waitForTimeout(1500);

// caption overlay in the site's own type
await p.addStyleTag({
  content: `
  #cap { position: fixed; left: 72px; top: 34%; z-index: 50; pointer-events: none; max-width: 560px;
    opacity: 0; transform: translateY(10px); transition: opacity .7s ease, transform .9s cubic-bezier(.2,.7,.2,1); }
  #cap.on { opacity: 1; transform: none; }
  #cap .k { font: 500 12px var(--f-mono); letter-spacing: .18em; text-transform: uppercase; color: var(--signal); }
  #cap .h { font: italic 400 64px/1.02 var(--f-display); color: #f3efe7; margin: 14px 0 14px; letter-spacing: -.01em; text-shadow: 0 2px 30px rgba(0,0,0,.6); }
  #cap .s { font: 400 17px/1.5 var(--f-ui); color: rgba(243,239,231,.72); text-shadow: 0 1px 12px rgba(0,0,0,.8); }
  #cap .zh { font: 400 15px/1.5 var(--f-ui); color: rgba(243,239,231,.5); margin-top: 6px; letter-spacing: .04em; }
  :root[data-env="ocean"] #cap .h { color: #0f1e26; text-shadow: 0 1px 24px rgba(255,255,255,.55); }
  :root[data-env="ocean"] #cap .s { color: rgba(15,30,38,.78); text-shadow: none; }
  :root[data-env="ocean"] #cap .zh { color: rgba(15,30,38,.6); }
  #fade { position: fixed; inset: 0; z-index: 60; background: #000; opacity: 1; transition: opacity 1.2s ease; pointer-events: none; }
  #fade.off { opacity: 0; }
  #end { position: fixed; inset: 0; z-index: 70; display: grid; place-content: center; text-align: center; gap: 18px;
    background: radial-gradient(ellipse at center, rgba(6,7,10,.55), rgba(6,7,10,.92)); opacity: 0; transition: opacity 1.2s ease; pointer-events: none; }
  #end.on { opacity: 1; }
  #end .h { font: italic 400 96px/1 var(--f-display); color: #f3efe7; }
  #end .s { font: 400 20px var(--f-ui); color: rgba(243,239,231,.75); }
  #end .u { font: 500 16px var(--f-mono); color: var(--signal); letter-spacing: .04em; margin-top: 10px; }
  `,
});
await p.evaluate(() => {
  const cap = document.createElement("div");
  cap.id = "cap";
  const fade = document.createElement("div");
  fade.id = "fade";
  const end = document.createElement("div");
  end.id = "end";
  document.body.append(cap, fade, end);
  const q = document.querySelector(".console-head select");
  q.value = "high";
  q.dispatchEvent(new Event("change"));
  const c = document.querySelector(".console");
  if (c && !c.classList.contains("collapsed")) c.querySelector(".collapse-btn").click();
  // slow camera sway around the framed view (auto-framing paused while it runs)
  window.__sway = (on) => {
    const st = osr.stage;
    cancelAnimationFrame(window.__sr);
    if (!on) return st.recenter();
    st.autoFrame = false;
    const t0 = performance.now();
    let prev = 0;
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      const a = 0.32 * Math.sin(t * 0.42);
      const off = st.camera.position.clone().sub(st.controls.target);
      off.applyAxisAngle(new off.constructor(0, 0, 1), a - prev);
      prev = a;
      st.camera.position.copy(st.controls.target).add(off);
      st.invalidate();
      window.__sr = requestAnimationFrame(loop);
    };
    loop();
  };
});

const caption = (k, h, s, zh) =>
  p.evaluate(
    async ([k, h, s, zh]) => {
      const cap = document.getElementById("cap");
      cap.classList.remove("on");
      await new Promise((r) => setTimeout(r, 450));
      if (!h) return;
      cap.innerHTML = `<div class="k">${k}</div><div class="h">${h}</div><div class="s">${s}</div><div class="zh">${zh}</div>`;
      cap.classList.add("on");
    },
    [k, h, s, zh],
  );

// screencast
const cdp = await p.context().newCDPSession(p);
const frames = [];
const marks = [];
cdp.on("Page.screencastFrame", async (f) => {
  const name = `${String(frames.length).padStart(5, "0")}.jpg`;
  writeFileSync(OUT + name, Buffer.from(f.data, "base64"));
  frames.push({ name, t: f.metadata.timestamp });
  await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
const mark = (label) => marks.push({ label, t: Date.now() / 1000 });
const wait = (ms) => p.waitForTimeout(ms);
const ev = (fn, arg) => p.evaluate(fn, arg);

await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });

// 0 · intro
mark("intro");
await ev(() => __sway(true));
await ev(() => document.getElementById("fade").classList.add("off"));
await wait(900);
await caption("Open-Spiral-Robots", "A robot drawn<br>from one equation", "r = a·e<sup>bθ</sup>, from the nautilus to the galaxy", "一条对数螺旋，生成整只机器人");
await wait(4200);

// 1 · flexibility: curl, wave
mark("flex");
await caption("01 · Flexible", "Pull a cable,<br>it curls", "Live MuJoCo physics, right in the browser", "浏览器里实时物理仿真");
await ev(() => osr.setDirection(0, 1));
await wait(2600);
await ev(() => [...document.querySelectorAll(".console .btn-show")].find((x) => /wave/i.test(x.textContent))?.click());
await wait(3600);

// grasp a cylinder
mark("grasp");
await ev(() => (osr.setDirection(0, 0), osr.object("cylinder")));
await caption("01 · Flexible", "Wraps around<br>what it meets", "Contacts without penetration, at any size", "柔顺抓取，接触不穿模");
await wait(1500);
await ev(() => [...document.querySelectorAll(".console .btn-show")].find((x) => /grasp/i.test(x.textContent))?.click());
await wait(4200);
await ev(() => osr.object("none"));

// 2 · speed: strike + slow motion
mark("speed");
await ev(() => (__sway(false), osr.mode("speed")));
await caption("02 · Fast", "A strike in<br>milliseconds", "Tip speed and curl time, measured from the simulation", "毫秒级击打，速度实测");
await wait(1600);
await ev(() => osr.strike());
await wait(2800);
await ev(() => [...document.querySelectorAll(".console .btn-show")].find((x) => /slow/i.test(x.textContent))?.click());
await wait(4200);
await ev(() => document.querySelector(".live-chip").click());

// 3 · scale: millimetres to metres
mark("scale");
await ev(() => { osr.mode("scale"); const coin = [...document.querySelectorAll(".seg-item")].find((x) => /coin/i.test(x.textContent)); if (coin?.classList.contains("on")) coin.click(); });
await caption("03 · Any size", "Millimetres<br>to metres", "Same design, same material: smaller curls faster", "从毫米到米，一键缩放");
await wait(1200);
await ev(async () => {
  const path = [464, 50, 2000, 464];
  for (let k = 0; k < path.length - 1; k++) {
    const a = Math.log(path[k]), z = Math.log(path[k + 1]);
    const n = 26;
    for (let i = 1; i <= n; i++) {
      const s = i / n;
      const e = s < 0.5 ? 2 * s * s : 1 - 2 * (1 - s) * (1 - s);
      osr.setLength(Math.exp(a + (z - a) * e));
      await new Promise((r) => setTimeout(r, 80));
    }
    await new Promise((r) => setTimeout(r, 900));
  }
});
await wait(400);
await ev(() => (osr.reset(), osr.mode("flex"), osr.stage.recenter()));
await wait(1400);

// 5 · ocean
mark("ocean");
await ev(() => document.querySelector(".env-chip").click());
await ev(() => osr.setDirection(0, 0.9));
await wait(900);
await ev(() => __sway(true));
await caption("", "Space or<br>the open ocean", "Two scenes, one tool, nothing to install", "宇宙或深海，无需安装");
await wait(4500);
await caption("", "");
await ev(() => document.getElementById("fade").classList.remove("off"));
await wait(1300);
await ev(() => { document.querySelector(".env-chip").click(); osr.setDirection(0, 0); __sway(false); });
await wait(500);
await ev(() => document.getElementById("fade").classList.add("off"));


// 4 · engineering drawer
mark("eng");
await ev(() => osr.mode("flex"));
await caption("04 · Engineering", "Exact CAD,<br>ready to print", "STEP · STL · MuJoCo XML · PDF report", "精确 CAD，一键导出");
await wait(1600);
await caption("", "");
await ev(() => document.querySelector(".chip.accent").click());
await wait(5200);
await ev(() => [...document.querySelectorAll(".eng-sheet button")].find((x) => x.textContent.trim() === "×" || /close/i.test(x.getAttribute("aria-label") || x.title || ""))?.click());
await wait(900);

// outro
mark("outro");
await caption("", "");
await ev(() => osr.setDirection(0, 0.6));
await wait(600);
await ev(() => __sway(true));
await wait(1200);
await ev(() => document.getElementById("end").innerHTML = `<div class="h">OpenSpiRobs</div><div class="s">Design, simulate and export spiral robots in your browser</div><div class="u">github.com/homalozoa/Open-Spiral-Robots</div>`);
await ev(() => document.getElementById("end").classList.add("on"));
await wait(3800);
mark("end");

await cdp.send("Page.stopScreencast");
await wait(300);
writeFileSync("frames.json", JSON.stringify({ frames, marks }, null, 1));
console.log("frames", frames.length, "span", (frames.at(-1).t - frames[0].t).toFixed(1), "s");
await b.close();
