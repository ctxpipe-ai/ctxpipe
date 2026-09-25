import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("openai gen_ai spans", () => {
  it("emits gen_ai spans when OTEL starts before the openai module loads", async () => {
    const backendRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    )
    const { stdout } = await execFileAsync(
      "bun",
      ["src/observability/genAiSpan.proof.ts"],
      { cwd: backendRoot },
    )
    const result = JSON.parse(stdout) as {
      ok: boolean
      genAi: { name: string; attributes: Record<string, unknown> }[]
    }
    expect(result.ok).toBe(true)
    expect(
      result.genAi.some((span) =>
        Object.keys(span.attributes).some((key) => key.startsWith("gen_ai")),
      ),
    ).toBe(true)
  }, 30_000)
})
