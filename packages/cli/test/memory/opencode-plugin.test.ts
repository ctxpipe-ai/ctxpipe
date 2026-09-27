import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { OPENCODE_PLUGIN } from "../../src/memory/hooks.js"

type ShellCall = { command: string; input: string }
type Hooks = {
  "chat.message": (
    input: { sessionID: string },
    output: { parts: Array<{ type: string; text?: string }> },
  ) => Promise<void>
  event: (input: {
    event: { type: string; properties?: { sessionID?: string } }
  }) => Promise<void>
}

/** Stand-in for Bun's `$`: records the command and piped stdin, returns `stdout`. */
function fakeShell(stdout: string): {
  $: unknown
  calls: Array<Promise<ShellCall>>
} {
  const calls: Array<Promise<ShellCall>> = []
  const $ = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = strings.reduce(
      (acc, s, i) =>
        acc + s + (i < values.length && typeof values[i] === "string" ? values[i] : ""),
      "",
    )
    const stdin = values.find((v) => v instanceof Response) as Response
    calls.push(stdin.text().then((input) => ({ command, input })))
    const chain = {
      cwd: () => chain,
      quiet: () => chain,
      nothrow: () => chain,
      text: async () => stdout,
    }
    return chain
  }
  return { $, calls }
}

async function loadPlugin(stdout: string) {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-opencode-plugin-"))
  const file = join(dir, "ctxpipe-memory.mjs")
  writeFileSync(file, OPENCODE_PLUGIN)
  const mod = (await import(pathToFileURL(file).href)) as {
    CtxpipeMemory: (ctx: unknown) => Promise<Hooks>
  }
  const prompts: unknown[] = []
  const client = { session: { prompt: async (req: unknown) => prompts.push(req) } }
  const shell = fakeShell(stdout)
  const hooks = await mod.CtxpipeMemory({
    client,
    $: shell.$,
    directory: "/repo",
  })
  return { hooks, prompts, calls: shell.calls }
}

describe("OpenCode memory capture plugin", () => {
  it("observes user prompts", async () => {
    const { hooks, calls } = await loadPlugin("{}")
    await hooks["chat.message"](
      { sessionID: "ses_1" },
      { parts: [{ type: "text", text: "From now on always use pnpm" }] },
    )
    const [call] = await Promise.all(calls)
    expect(call?.command).toContain(
      "memory capture observe --host opencode --event UserPromptSubmit",
    )
    expect(JSON.parse(call?.input ?? "{}")).toMatchObject({
      cwd: "/repo",
      prompt: "From now on always use pnpm",
      session_id: "ses_1",
    })
  })

  it("posts the Stop follow-up into the session when the turn ends", async () => {
    const followup = "Uncommitted memory (1 file on `main`): .ai/memory/lessons-learned.md."
    const { hooks, prompts, calls } = await loadPlugin(
      JSON.stringify({ followup_message: followup }),
    )
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    const [call] = await Promise.all(calls)
    expect(call?.command).toContain(
      "memory capture finalize --host opencode --event Stop",
    )
    expect(prompts).toEqual([
      {
        path: { id: "ses_1" },
        body: { parts: [{ type: "text", text: followup }] },
      },
    ])
  })

  it("posts nothing when capture has nothing to say", async () => {
    const { hooks, prompts } = await loadPlugin("{}")
    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "ses_1" } },
    })
    await hooks.event({ event: { type: "file.edited" } })
    expect(prompts).toEqual([])
  })
})
