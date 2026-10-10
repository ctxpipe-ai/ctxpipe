import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { UI_PROXY_TIMEOUT_MS } from "./ui.js"

// The UI image runs the Nitro `bun` preset. That entry passes
// `NITRO_BUN_IDLE_TIMEOUT` to Bun.serve; without it, Bun closes a silent
// request after about 10 s, before the 15 s proxy timeout.
describe("UI server idle timeout", () => {
  it("keeps the UI image idle timeout above the UI proxy timeout", async () => {
    const dockerfile = await readFile(
      fileURLToPath(new URL("../../../ui/Dockerfile", import.meta.url)),
      "utf8",
    )
    const idleTimeout = Number(
      /^ENV NITRO_BUN_IDLE_TIMEOUT=(\d+)$/m.exec(dockerfile)?.[1],
    )
    // Bun checks idle sockets on a 4 s sweep, so it can close up to 4 s early.
    expect((idleTimeout - 4) * 1000).toBeGreaterThan(UI_PROXY_TIMEOUT_MS)
  })
})
