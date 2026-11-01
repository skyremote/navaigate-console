// Runs inside headless Chrome. Draws every loop frame of every mascot with the same shaders the live renderer
// uses and posts each finished strip back to build-strips.mjs, which writes mascots3d/strips.generated.ts.
import { CHARACTERS_3D, PALETTE, hexToRgb, loopFor, lookForFrame, statesFor } from "../mascots3d/catalog";
import { sharedGl } from "../mascots3d/gl";
import { FRAME } from "../mascots3d/stripspec";

const QUALITY = 0.66;
const SUPERSAMPLE = 3;

async function post(key: string, uri: string) {
  await fetch("/strip?key=" + encodeURIComponent(key), { method: "POST", body: uri });
}

async function run() {
  const gl = sharedGl();
  let count = 0;
  const only = (new URLSearchParams(location.search).get("only") ?? "").split(",").filter(Boolean);
  for (const c of CHARACTERS_3D) {
    if (only.length && !only.includes(c.id)) continue;
    for (const state of statesFor(c.id)) {
      const colours = state === "error" || c.fixedColour ? [0] : PALETTE.map((_, i) => i);
      const loop = loopFor(c.id, state);
      for (const ci of colours) {
        const canvas = document.createElement("canvas");
        canvas.width = FRAME * loop.frames;
        canvas.height = FRAME;
        const ctx = canvas.getContext("2d")!;
        for (let f = 0; f < loop.frames; f++) {
          const ok = gl.draw(c.id, lookForFrame(c.id, state, f), hexToRgb(PALETTE[ci]), FRAME, SUPERSAMPLE);
          if (!ok) throw new Error(`draw failed for ${c.id}`);
          ctx.save();
          ctx.translate(f * FRAME, 0);
          gl.blit(ctx, FRAME);
          ctx.restore();
        }
        await post(`${c.id}:${state}:${ci}`, canvas.toDataURL("image/webp", QUALITY));
        count++;
      }
    }
  }
  await fetch("/done?count=" + count, { method: "POST" });
}

run().catch((e) => fetch("/fail", { method: "POST", body: String(e?.stack ?? e) }));
