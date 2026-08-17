import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

type CandidateRow = {
  candidateId?: string
  sourceHost?: string
  excerpt?: string
}

function run(
  cwd: string,
  args: string[],
  home?: string,
  stdin?: string,
): string {
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

/** Case-insensitive Markdown search under root, skipping events/. */
function searchMarkdown(root: string, query: string): string[] {
  const needle = query.toLowerCase()
  const hits: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const rel = relative(root, full)
      if (rel.split(/[/\\]/).includes("events")) continue
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      const body = readFileSync(full, "utf8")
      if (body.toLowerCase().includes(needle)) {
        hits.push(`${rel}\n${body}`)
      }
    }
  }
  walk(root)
  return hits
}

function readCandidates(cwd: string): CandidateRow[] {
  const path = join(cwd, ".ai", "memory", "events", "candidates.jsonl")
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CandidateRow)
}

function readLifecycle(cwd: string): {
  surfaced: string[]
  promoted: string[]
  dismissed: string[]
} {
  const path = join(cwd, ".ai", "memory", "events", "lifecycle.json")
  if (!existsSync(path)) return { surfaced: [], promoted: [], dismissed: [] }
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    surfaced?: string[]
    promoted?: string[]
    dismissed?: string[]
  }
  return {
    surfaced: Array.isArray(data.surfaced) ? data.surfaced : [],
    promoted: Array.isArray(data.promoted) ? data.promoted : [],
    dismissed: Array.isArray(data.dismissed) ? data.dismissed : [],
  }
}

describe("memory harness e2e (Layer A)", () => {
  it(
    "init → observe fixtures → summary → promote → recall → upgrade cleanup",
    { timeout: 30_000 },
    () => {
      const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-harness-"))
      const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-harness-home-"))

      // 1) Init harness
      run(
        cwd,
        ["memory", "init", "--agents", "cursor", "--non-interactive"],
        home,
      )
      expect(existsSync(join(cwd, ".ai", "memory", "index.md"))).toBe(true)
      expect(existsSync(join(cwd, ".cursor", "hooks.json"))).toBe(true)
      expect(
        existsSync(join(cwd, ".cursor", "skills", "memory-search", "SKILL.md")),
      ).toBe(true)

      // 2a) Cursor afterFileEdit through observe CLI — must write on its own
      const cursorEdit = {
        ...(JSON.parse(
          readFileSync(join(FIXTURES, "cursor-afterFileEdit.json"), "utf8"),
        ) as Record<string, unknown>),
        cwd,
      }
      run(
        cwd,
        [
          "memory",
          "capture",
          "observe",
          "--host",
          "cursor",
          "--event",
          "afterFileEdit",
        ],
        home,
        JSON.stringify(cursorEdit),
      )
      const afterObserve = readCandidates(cwd)
      expect(afterObserve.length).toBeGreaterThanOrEqual(1)
      expect(
        afterObserve.some(
          (c) =>
            c.sourceHost === "cursor" &&
            typeof c.excerpt === "string" &&
            /4000/.test(c.excerpt),
        ),
      ).toBe(true)
      const cursorCount = afterObserve.length

      // 2b) Claude Stop finalize: observe + summarize + ack after stdout
      const claudeStop = {
        ...(JSON.parse(
          readFileSync(join(FIXTURES, "claude-stop.json"), "utf8"),
        ) as Record<string, unknown>),
        cwd,
      }
      const finalizeOut = run(
        cwd,
        [
          "memory",
          "capture",
          "finalize",
          "--host",
          "claude",
          "--event",
          "Stop",
        ],
        home,
        JSON.stringify(claudeStop),
      )
      expect(finalizeOut.trim().length).toBeGreaterThan(0)
      const lastLine = finalizeOut.trim().split("\n").at(-1)
      expect(lastLine).toBeTruthy()
      if (!lastLine) throw new Error("expected finalize stdout line")
      const stopPayload = JSON.parse(lastLine) as Record<string, unknown>
      expect(Object.keys(stopPayload).length).toBeGreaterThan(0)

      const afterFinalize = readCandidates(cwd)
      expect(afterFinalize.length).toBeGreaterThan(cursorCount)
      const claudeIds = afterFinalize
        .filter(
          (c) =>
            c.sourceHost === "claude" &&
            typeof c.excerpt === "string" &&
            /decisions/i.test(c.excerpt) &&
            typeof c.candidateId === "string",
        )
        .map((c) => c.candidateId as string)
      expect(claudeIds.length).toBeGreaterThan(0)

      const lifecycleAfterStop = readLifecycle(cwd)
      // Finalize must summarize then ack *including* newly observed Claude ids
      // (observe-after-ack ordering regressions leave Claude pending forever).
      for (const id of claudeIds) {
        expect(lifecycleAfterStop.surfaced).toContain(id)
      }
      for (const row of afterObserve) {
        if (row.candidateId) {
          expect(lifecycleAfterStop.surfaced).toContain(row.candidateId)
        }
      }

      // Hooks must not have written an ADR
      const decisions = join(cwd, ".ai", "memory", "decisions")
      const adrIndex = existsSync(join(decisions, "index.md"))
        ? readFileSync(join(decisions, "index.md"), "utf8")
        : ""
      expect(adrIndex).not.toMatch(/ADR-\d{3}-/)

      // 3) Promote one surfaced candidate via CLI; plant durable Markdown
      const promotedId = lifecycleAfterStop.surfaced[0]
      expect(promotedId).toBeTruthy()
      if (!promotedId) throw new Error("expected surfaced candidate id")
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
      const promoteOut = run(
        cwd,
        ["memory", "capture", "promote", promotedId],
        home,
      )
      expect(JSON.parse(promoteOut.trim())).toMatchObject({
        ok: true,
        promoted: [promotedId],
      })
      const lifecycleAfterPromote = readLifecycle(cwd)
      expect(lifecycleAfterPromote.promoted).toContain(promotedId)
      expect(lifecycleAfterPromote.surfaced).not.toContain(promotedId)

      // 4) Recall durable Markdown excluding events/ (no ripgrep dependency in CI)
      const hits = searchMarkdown(
        join(cwd, ".ai", "memory"),
        "billing service canonical port",
      )
      expect(hits.some((h) => h.includes("4000"))).toBe(true)
      expect(hits.some((h) => h.includes("candidates.jsonl"))).toBe(false)

      // 5) Upgrade cleanup on legacy dual layout
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
      run(
        cwd,
        ["memory", "init", "--agents", "cursor", "--non-interactive"],
        home,
      )
      expect(existsSync(join(cwd, ".cursor", "skills", "memory-sync"))).toBe(
        false,
      )
      const mcp = JSON.parse(
        readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
      ) as { mcpServers: Record<string, unknown> }
      expect(mcp.mcpServers["ctxpipe-memory"]).toBeUndefined()
      expect(readFileSync(lessonPath, "utf8")).toContain(planted)
    },
  )
})
