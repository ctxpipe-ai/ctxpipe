import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("openai gen_ai spans", () => {
  it("emits gen_ai spans for ChatOpenAI imported from @langchain/openai", async () => {
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
    const attributes = result.genAi[0]?.attributes
    expect(attributes).toMatchObject({
      "gen_ai.system": "openai",
      "gen_ai.provider.name": "openai",
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "gpt-test",
      "gen_ai.response.model": "gpt-test",
      "gen_ai.usage.input_tokens": 3,
      "gen_ai.usage.output_tokens": 2,
    })
  }, 30_000)
})
