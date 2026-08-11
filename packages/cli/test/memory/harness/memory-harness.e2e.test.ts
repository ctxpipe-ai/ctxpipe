import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  acknowledgeSurfaced,
  markPromoted,
  observeCapture,
  summarizeCapture,
} from "../../../src/memory/capture.js"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

function run(cwd: string, args: string[], home?: string, stdin?: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: {
      ...process.env,
      CI: "1",
      CTXPIPE_ORG_SLUG: "",
      CTXPIPE_ORG: "",
      ...(home ? { HOME: home } : {}),
    },
  })
}

describe("memory harness e2e (Layer A)", () => {
  it(
    "init → observe fixtures → summary → promote → recall → upgrade cleanup",
    { timeout: 30_000 },
    () => {
      const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-harness-"))
      const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-harness-home-"))

      // 1) Init harness
      run(cwd, ["memory", "init", "--agents", "cursor", "--non-interactive"], home)
      expect(existsSync(join(cwd, ".ai", "memory", "index.md"))).toBe(true)
      expect(existsSync(join(cwd, ".cursor", "hooks.json"))).toBe(true)
      expect(
        existsSync(join(cwd, ".cursor", "skills", "memory-search", "SKILL.md")),
      ).toBe(true)

      // 2) Observe recorded host fixtures
      const cursorEdit = JSON.parse(
        readFileSync(join(FIXTURES, "cursor-afterFileEdit.json"), "utf8"),
      ) as Record<string, unknown>
      const claudeStop = JSON.parse(
        readFileSync(join(FIXTURES, "claude-stop.json"), "utf8"),
      ) as Record<string, unknown>

      const editResult = observeCapture({
        host: "cursor",
        eventType: "afterFileEdit",
        cwd,
        payload: { ...cursorEdit, cwd },
      })
      expect(editResult.wrote).toBe(true)

      const stopResult = observeCapture({
        host: "claude",
        eventType: "Stop",
        cwd,
        payload: { ...claudeStop, cwd },
      })
      expect(stopResult.wrote).toBe(true)

      const candidatesPath = join(
        cwd,
        ".ai",
        "memory",
        "events",
        "candidates.jsonl",
      )
      expect(existsSync(candidatesPath)).toBe(true)
      const candidateLines = readFileSync(candidatesPath, "utf8")
        .trim()
        .split("\n")
      expect(candidateLines.length).toBeGreaterThanOrEqual(2)

      // 3) Summary surfaces batch; durable MD still absent for candidates
      const summary = summarizeCapture({ cwd })
      expect(summary.candidates.length).toBeGreaterThan(0)
      expect(summary.surfacedIds.length).toBe(summary.candidates.length)
      acknowledgeSurfaced(summary.surfacedIds, { cwd })

      // Hooks must not have written an ADR
      const decisions = join(cwd, ".ai", "memory", "decisions")
      const adrFiles = existsSync(decisions)
        ? readFileSync(join(decisions, "index.md"), "utf8")
        : ""
      expect(adrFiles).not.toMatch(/ADR-\d{3}-/)

      // 4) Promote one candidate into durable Markdown + index
      const promotedId = summary.surfacedIds[0]!
      const lessonPath = join(cwd, ".ai", "memory", "lessons-learned.md")
      const planted =
        "Planted harness fact: billing service canonical port is 4000."
      writeFileSync(
        lessonPath,
        `${readFileSync(lessonPath, "utf8").trimEnd()}\n\n## Harness\n\n- ${planted}\n`,
        "utf8",
      )
      const indexPath = join(cwd, ".ai", "memory", "index.md")
      writeFileSync(
        indexPath,
        `${readFileSync(indexPath, "utf8").trimEnd()}\n| Harness note | lessons-learned.md | ${planted} |\n`,
        "utf8",
      )
      markPromoted([promotedId], { cwd })

      // 5) Recall via rg excluding events/
      const rgOut = execFileSync(
        "rg",
        ["-i", "billing service canonical port", ".ai/memory", "--glob", "*.md", "--glob", "!events/**"],
        { cwd, encoding: "utf8" },
      )
      expect(rgOut).toContain("4000")
      expect(rgOut).not.toContain("candidates.jsonl")

      // 6) Upgrade cleanup on legacy dual layout
      mkdirSync(join(cwd, ".cursor", "skills", "memory-sync"), {
        recursive: true,
      })
      writeFileSync(
        join(cwd, ".cursor", "skills", "memory-sync", "SKILL.md"),
        "# legacy\n",
        "utf8",
      )
      writeFileSync(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "ctxpipe-memory": {
              command: "npx",
              args: ["-y", "ctxpipe", "memory", "mcp"],
            },
          },
        }),
        "utf8",
      )
      run(cwd, ["memory", "init", "--agents", "cursor", "--non-interactive"], home)
      expect(existsSync(join(cwd, ".cursor", "skills", "memory-sync"))).toBe(
        false,
      )
      const mcp = JSON.parse(
        readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, unknown> }
      expect(mcp.mcpServers["ctxpipe-memory"]).toBeUndefined()
      // Planted fact survives re-init (lessons seeded only-if-absent)
      expect(readFileSync(lessonPath, "utf8")).toContain(planted)
    },
  )
})
