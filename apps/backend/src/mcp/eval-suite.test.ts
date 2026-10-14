import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it } from "vitest"
import {
  type CallRule,
  type EvalCase,
  evalCases,
} from "../../evals/mcp/cases.js"
import {
  type Call,
  type CaseContext,
  casePrompt,
  checkCase,
  normalizeRepositoryRef,
  readToolNames,
  requireReadTools,
  resolveOrgArgs,
  transcriptFromMessages,
} from "../../evals/mcp/check.js"
import {
  type Baseline,
  baselineFromRun,
  evaluateGate,
  gateThresholds,
  type RunResult,
} from "../../evals/mcp/gate.js"
import { MCP_TOOL_ERROR_CODES } from "./framework/tool-errors.js"
import { registerMcpReadTools } from "./framework/tool-registry.js"
import { findSymbolTool } from "./tools/find-symbol.js"
import { getRelatedTool } from "./tools/get-related.js"
import { listFilesTool } from "./tools/list-files.js"
import { listWorkspaces } from "./tools/list-workspaces.js"
import { readFileTool } from "./tools/read-file.js"
import { searchCodeTool } from "./tools/search-code.js"
import { searchKnowledgeTool } from "./tools/search-knowledge.js"

const evalsDirectory = fileURLToPath(
  new URL("../../evals/mcp/", import.meta.url),
)
const orgs = { harbor: "mcp-eval-t1-harbor", meadow: "mcp-eval-t1-meadow" }
const read: CaseContext = { orgs }

function fixtureFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? fixtureFiles(join(directory, entry.name))
      : [join(directory, entry.name)],
  )
}

/** Paths and contents of every fixture file: the facts that a case may expect. */
const fixtureCorpus = fixtureFiles(join(evalsDirectory, "fixtures"))
  .map(
    (file) =>
      `${relative(evalsDirectory, file)}\n${readFileSync(file, "utf8")}`,
  )
  .join("\n")
  .toLowerCase()

function byId(id: string): EvalCase {
  const found = evalCases.find((item) => item.id === id)
  if (!found) throw new Error(`No case ${id}`)
  return found
}

let callIndex = 0
function call(
  tool: string,
  args: Record<string, unknown>,
  extra: Partial<Call> = {},
): Call {
  callIndex += 1
  return {
    step: callIndex,
    tool,
    args,
    resultText: "",
    isError: false,
    ...extra,
  }
}

describe("eval case data", () => {
  it("has about 20 cases with unique ids", () => {
    const ids = evalCases.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBeGreaterThanOrEqual(20)
  })

  it("covers each scenario that CTX-574 names", () => {
    const ids = evalCases.map((item) => item.id)
    for (const id of [
      "design-idempotency-retention",
      "parallel-knowledge-and-code",
      "two-orgs-one-session",
      "no-repository-agent",
      "stale-cursor",
      "structural-search",
      "get-related-governing-decision",
      "current-repository-trap-https",
      "current-repository-trap-ssh",
    ]) {
      expect(ids).toContain(id)
    }
  })

  it("expects only facts that the fixtures hold", () => {
    for (const item of evalCases) {
      for (const text of [
        ...(item.facts ?? []),
        ...(item.resultsMention ?? []),
        ...(item.notInAnswer ?? []),
      ]) {
        // A tool error code comes from the server, not from the fixtures.
        if ((MCP_TOOL_ERROR_CODES as readonly string[]).includes(text)) continue
        expect(fixtureCorpus, `${item.id}: ${text}`).toContain(
          text.toLowerCase(),
        )
      }
    }
  })

  it("names the seeded orgs only through placeholders", () => {
    const rules = evalCases.flatMap((item) => [
      ...(item.calls ?? []),
      ...(item.forbidden ?? []),
    ])
    for (const rule of rules) {
      const org = rule.args?.org
      if (org && "equals" in org) {
        expect(["$harbor", "$meadow"]).toContain(org.equals)
      }
    }
  })

  it("uses tool names and arguments that the registered tools accept", async () => {
    const server = new McpServer({ name: "eval-schema", version: "0.0.0" })
    registerMcpReadTools(server, [
      listWorkspaces,
      searchKnowledgeTool,
      searchCodeTool,
      findSymbolTool,
      readFileTool,
      listFilesTool,
      getRelatedTool,
    ])
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "eval-schema-client", version: "0.0.0" })
    await Promise.all([server.connect(serverSide), client.connect(clientSide)])
    const { tools } = await client.listTools()
    await client.close()
    const schemas = new Map(tools.map((tool) => [tool.name, tool.inputSchema]))

    const rules: CallRule[] = evalCases.flatMap((item) => [
      ...(item.calls ?? []),
      ...(item.forbidden ?? []),
    ])
    for (const rule of rules) {
      for (const tool of Array.isArray(rule.tool) ? rule.tool : [rule.tool]) {
        if (tool === "*") continue
        expect(readToolNames as readonly string[]).toContain(tool)
        const schema = schemas.get(tool)
        if (!schema) throw new Error(`Unregistered tool ${tool}`)
        const properties = (schema.properties ?? {}) as Record<
          string,
          { enum?: unknown[] }
        >
        for (const [name, arg] of Object.entries(rule.args ?? {})) {
          if (!properties[name]) {
            if (rule.tool === "*") continue
            throw new Error(`${tool} has no argument ${name}`)
          }
          const values = "equals" in arg ? [arg.equals] : []
          const allowed = properties[name]?.enum
          if (allowed)
            for (const value of values) expect(allowed).toContain(value)
        }
      }
    }
  })
})

describe("checkCase", () => {
  it("passes a run that satisfies every rule", () => {
    const outcome = checkCase(
      byId("design-idempotency-retention"),
      {
        calls: [
          call(
            "search_knowledge",
            { org: orgs.harbor, query: "idempotency key retention" },
            { resultText: "knowledge/decisions/idempotency.md" },
          ),
        ],
        text: "Keep each key for 48 hours.",
      },
      read,
    )
    expect(outcome).toEqual({ passed: true, failures: [] })
  })

  it("fails a wrong org, a missing fact, and an irrelevant result", () => {
    const outcome = checkCase(
      byId("design-idempotency-retention"),
      {
        calls: [call("search_knowledge", { org: orgs.meadow, query: "x" })],
        text: "Keep keys for a day.",
      },
      read,
    )
    expect(outcome.passed).toBe(false)
    expect(outcome.failures.join("\n")).toContain("no call matches")
    expect(outcome.failures.join("\n")).toContain('lacks "48 hours"')
    expect(outcome.failures.join("\n")).toContain("no tool result mentions")
  })

  it("requires parallel calls in one assistant step", () => {
    const item = byId("parallel-knowledge-and-code")
    const base = { text: "It uses idempotency." }
    const sequential = checkCase(
      item,
      {
        ...base,
        calls: [
          call("search_knowledge", { org: orgs.harbor }, { step: 1 }),
          call("search_code", { excludeRepositories: [] }, { step: 2 }),
        ],
      },
      read,
    )
    expect(sequential.failures.join("\n")).toContain("no single step calls")
    const parallel = checkCase(
      item,
      {
        ...base,
        calls: [
          call("search_knowledge", { org: orgs.harbor }, { step: 1 }),
          call(
            "search_code",
            { excludeRepositories: ["example/checkout-app"] },
            { step: 1 },
          ),
        ],
      },
      read,
    )
    expect(parallel.passed).toBe(true)
  })

  it("needs two read_file calls in one step for parallel reads", () => {
    const item = byId("parallel-reads")
    const one = checkCase(
      item,
      {
        text: "The disk is full.",
        calls: [call("read_file", { workspace: "payments" }, { step: 1 })],
      },
      read,
    )
    expect(one.passed).toBe(false)
    const two = checkCase(
      item,
      {
        text: "The disk is full.",
        calls: [
          call("read_file", { workspace: "payments" }, { step: 4 }),
          call("read_file", { workspace: "payments" }, { step: 4 }),
        ],
      },
      read,
    )
    expect(two.passed).toBe(true)
  })

  it("accepts each git form of the working repository and refuses a missing one", () => {
    const item = byId("current-repository-trap-https")
    const run = (excludeRepositories: unknown) =>
      checkCase(
        item,
        {
          text: "It is in yocto-queue.",
          calls: [
            call(
              "search_code",
              { excludeRepositories },
              { resultText: "sindresorhus/yocto-queue:index.js" },
            ),
          ],
        },
        read,
      )
    for (const form of [
      "sindresorhus/is",
      "https://github.com/sindresorhus/is",
      "https://github.com/sindresorhus/is.git",
      "git@github.com:sindresorhus/is.git",
      "ssh://git@github.com/Sindresorhus/is.git/",
    ]) {
      expect(run([form]).passed, form).toBe(true)
    }
    expect(run([]).passed).toBe(false)
    expect(run(["sindresorhus/yocto-queue"]).passed).toBe(false)
    expect(run(undefined).failures.join("\n")).toContain(
      "lacks excludeRepositories",
    )
  })

  it("fails a read of the working repository", () => {
    const outcome = checkCase(
      byId("current-repository-trap-ssh"),
      {
        text: "yocto-queue",
        calls: [
          call("search_code", { excludeRepositories: ["sindresorhus/is"] }),
          call("read_file", { ref: "sindresorhus/is:source/index.ts" }),
        ],
      },
      read,
    )
    expect(outcome.failures.join("\n")).toContain("forbidden call")
  })

  it("accepts an empty exclusion only when the agent has no repository", () => {
    const item = byId("no-repository-agent")
    const run = (excludeRepositories: string[]) =>
      checkCase(
        item,
        {
          text: "yocto-queue defines it.",
          calls: [
            call(
              "find_symbol",
              { org: orgs.harbor, excludeRepositories },
              { resultText: "sindresorhus/yocto-queue" },
            ),
          ],
        },
        read,
      )
    expect(run([]).passed).toBe(true)
    expect(run(["example/other"]).passed).toBe(false)
  })

  it("forbids a call to the other org", () => {
    const outcome = checkCase(
      byId("org-scope-respected"),
      {
        text: "Not found.",
        calls: [call("search_knowledge", { org: orgs.meadow, query: "x" })],
      },
      read,
    )
    expect(outcome.failures.join("\n")).toContain("forbidden call")
    const leaked = checkCase(
      byId("org-scope-respected"),
      { text: "It settles at midnight.", calls: [] },
      read,
    )
    expect(leaked.failures.join("\n")).toContain('contains "midnight"')
  })

  it("checks recovery after a stale cursor", () => {
    const item = byId("stale-cursor")
    const stale = call(
      "search_knowledge",
      { org: orgs.harbor, query: "idempotency", cursor: "abc" },
      {
        isError: true,
        resultText: "error:\n  code: stale_cursor\n  retryable: false",
      },
    )
    const ok = checkCase(
      item,
      {
        text: "Keep keys for 48 hours.",
        calls: [
          stale,
          call("search_knowledge", { org: orgs.harbor, query: "idempotency" }),
        ],
      },
      read,
    )
    expect(ok.passed).toBe(true)
    const stuck = checkCase(
      item,
      { text: "Keep keys for 48 hours.", calls: [stale] },
      read,
    )
    expect(stuck.passed).toBe(false)
    // A cursor that the server calls invalid did not prove the stale path.
    const invalid = checkCase(
      item,
      {
        text: "Keep keys for 48 hours.",
        calls: [
          { ...stale, resultText: "error:\n  code: invalid_cursor" },
          call("search_knowledge", { org: orgs.harbor, query: "idempotency" }),
        ],
      },
      read,
    )
    expect(invalid.failures.join()).toContain('"stale_cursor"')
  })

  it("puts a real cursor from the first projection into the stale-cursor prompt", () => {
    const item = byId("stale-cursor")
    expect(item.cursorFrom).toBeDefined()
    const args = resolveOrgArgs(item.cursorFrom ?? {}, orgs)
    expect(args).toMatchObject({ org: orgs.harbor, query: "idempotency" })
    const prompt = casePrompt(item, "CURSOR-1")
    expect(prompt).toContain("CURSOR-1")
    expect(prompt).not.toContain("{cursor}")
    // The cursor is bound to the query, so the prompt must give the same arguments.
    for (const value of Object.values(item.cursorFrom ?? {}).flat())
      if (typeof value === "string" && !value.startsWith("$"))
        expect(prompt).toContain(value)
    expect(() => casePrompt(item)).toThrow("cursor")
    expect(casePrompt(byId("structural-search"))).toBe(
      byId("structural-search").prompt,
    )
  })

  it("checks structural search arguments", () => {
    const item = byId("structural-search")
    const run = (args: Record<string, unknown>) =>
      checkCase(
        item,
        {
          text: "",
          calls: [
            call(
              "search_code",
              { excludeRepositories: ["example/checkout-app"], ...args },
              { resultText: "sindresorhus/yocto-queue:index.js" },
            ),
          ],
        },
        read,
      )
    expect(run({ mode: "structural", language: "javascript" }).passed).toBe(
      true,
    )
    expect(run({ mode: "structural" }).passed).toBe(false)
    expect(run({ mode: "literal", language: "javascript" }).passed).toBe(false)
  })

  it("requires the graph seed and intent, and a relevant result", () => {
    const item = byId("get-related-governing-decision")
    const judge = (args: Record<string, unknown>, resultText: string) =>
      checkCase(
        item,
        {
          text: "The idempotency decision governs it.",
          calls: [
            call(
              "get_related",
              { org: orgs.harbor, workspace: "payments", ...args },
              { resultText },
            ),
          ],
        },
        read,
      )
    const args = { seeds: ["knowledge/services/settlement.md"], intent: "why" }
    expect(judge(args, "knowledge/decisions/idempotency.md").passed).toBe(true)
    expect(judge({}, "knowledge/decisions/idempotency.md").passed).toBe(false)
    expect(
      judge(
        { ...args, seeds: ["knowledge/services/ledger.md"] },
        "knowledge/decisions/idempotency.md",
      ).passed,
    ).toBe(false)
    expect(judge(args, "").passed).toBe(false)
  })
})

describe("normalizeRepositoryRef", () => {
  it("reduces each form to owner/name", () => {
    expect(normalizeRepositoryRef("git@github.com:Foo/Bar.git")).toBe("foo/bar")
    expect(normalizeRepositoryRef("https://github.com/foo/bar/")).toBe(
      "foo/bar",
    )
    expect(normalizeRepositoryRef("foo/bar")).toBe("foo/bar")
  })
})

describe("transcriptFromMessages", () => {
  const messages = [
    { role: "user", content: "Question" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I search." },
        {
          type: "tool-call",
          toolCallId: "a",
          toolName: "search_knowledge",
          input: { org: "o", query: "q" },
        },
        {
          type: "tool-call",
          toolCallId: "b",
          toolName: "search_code",
          input: { excludeRepositories: [] },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "a",
          toolName: "search_knowledge",
          output: { type: "json", value: { hits: ["knowledge/x.md"] } },
        },
        {
          type: "tool-result",
          toolCallId: "b",
          toolName: "search_code",
          output: { type: "error-text", value: "stale_cursor" },
        },
      ],
    },
    { role: "assistant", content: [{ type: "text", text: "Done." }] },
  ]

  it("keeps parallel calls in one step and reads results and errors", () => {
    const transcript = transcriptFromMessages(messages)
    expect(transcript.text).toBe("Done.")
    expect(transcript.calls.map((item) => [item.tool, item.step])).toEqual([
      ["search_knowledge", 1],
      ["search_code", 1],
    ])
    expect(transcript.calls[0]?.resultText).toContain("knowledge/x.md")
    expect(transcript.calls[0]?.isError).toBe(false)
    expect(transcript.calls[1]?.isError).toBe(true)
  })

  it("reads the MCP result flag and the older args field", () => {
    const transcript = transcriptFromMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "read_file",
            args: { ref: "r" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c",
            output: { isError: true, content: [{ type: "text", text: "no" }] },
          },
        ],
      },
    ])
    expect(transcript.calls[0]).toMatchObject({
      args: { ref: "r" },
      isError: true,
    })
  })
})

describe("requireReadTools", () => {
  it("accepts only the seven read tools", () => {
    expect(() => requireReadTools(["ctx_advisor"])).toThrow(
      "Unexpected tool set",
    )
    expect(() => requireReadTools([...readToolNames, "unknown"])).toThrow(
      "unknown",
    )
    expect(() => requireReadTools([...readToolNames])).not.toThrow()
    expect(() => requireReadTools(["ctx_advisor", "list_workspaces"])).toThrow(
      "Unexpected tool set",
    )
    expect(() => requireReadTools(readToolNames.slice(0, 6))).toThrow(
      "get_related",
    )
    expect(() => requireReadTools([])).toThrow("Unexpected tool set")
  })
})

describe("evaluateGate", () => {
  const ids = ["a", "b"]
  /** Passes of model m1 for cases a and b; m2 passes everything. 3 iterations. */
  const run = (a: number, b: number): RunResult => ({
    iterations: 3,
    passes: { m1: { a, b }, m2: { a: 3, b: 3 } },
  })
  const baseline = baselineFromRun(run(3, 3), ids, "2026-10-14T00:00:00Z")

  it("passes a full run with no baseline and notes the missing baseline", () => {
    const report = evaluateGate(run(3, 3), null, ids)
    expect(report.passed).toBe(true)
    expect(report.notes.join()).toContain("no stored baseline")
    expect(report.notes.join()).toContain(`${gateThresholds.minPassRate}`)
  })

  it("fails below the pass-rate floor", () => {
    const report = evaluateGate(run(3, 1), null, ids)
    expect(report.passed).toBe(false)
    expect(report.failures.join()).toContain(
      `below ${gateThresholds.minPassRate}`,
    )
  })

  it("fails a run with fewer than two models", () => {
    const report = evaluateGate(
      { iterations: 3, passes: { m1: { a: 3, b: 3 } } },
      null,
      ids,
    )
    expect(report.passed).toBe(false)
    expect(report.failures.join()).toContain("at least 2 models")
  })

  it("divides by the requested iterations, so an iteration that threw is a failure", () => {
    // m1 case b: 3 requested, 2 passed, 1 threw and recorded nothing.
    const result: RunResult = {
      iterations: 3,
      passes: {
        m1: { a: 3, b: 2, c: 3, d: 3 },
        m2: { a: 3, b: 3, c: 3, d: 3 },
      },
    }
    const report = evaluateGate(result, null, ["a", "b", "c", "d"])
    // 11 of 12 iterations is 0.917.
    expect(report.passed).toBe(true)
    expect(report.aggregates.m1).toBeCloseTo(11 / 12)
    const worse: RunResult = {
      iterations: 3,
      passes: { m1: { a: 3, b: 1, c: 3, d: 3 }, m2: result.passes.m2 ?? {} },
    }
    expect(evaluateGate(worse, null, ["a", "b", "c", "d"]).passed).toBe(false)
  })

  it("fails when one case falls more than the case threshold from the baseline", () => {
    const report = evaluateGate(run(3, 1), baseline, ids)
    expect(report.failures.join()).toContain("case b fell")
  })

  it("fails when the aggregate falls from the baseline by more than the allowed drop", () => {
    const result: RunResult = {
      iterations: 3,
      passes: { m1: { a: 3, b: 3 }, m2: { a: 3, b: 2 } },
    }
    // 5/6 = 0.833 is below the floor too; the drop message must also appear.
    const report = evaluateGate(result, baseline, ids)
    expect(report.failures.join()).toContain("m2: pass rate fell")
  })

  it("fails a missing case result and a baseline model that did not run", () => {
    const result: RunResult = {
      iterations: 3,
      passes: { m1: { a: 3 }, m3: { a: 3, b: 3 } },
    }
    const report = evaluateGate(result, baseline, ids)
    expect(report.failures.join()).toContain("m1: case b has no result")
    expect(report.failures.join()).toContain(
      "m2: in the baseline but did not run",
    )
  })

  it("fails an empty run", () => {
    expect(evaluateGate({ iterations: 3, passes: {} }, null, ids).passed).toBe(
      false,
    )
  })

  it("stores pass rates that a later run compares with", () => {
    expect(baseline.models.m1).toEqual({ aggregate: 1, cases: { a: 1, b: 1 } })
  })
})

describe("baseline.json", () => {
  it("holds null or one recorded entry", () => {
    const stored = JSON.parse(
      readFileSync(join(evalsDirectory, "baseline.json"), "utf8"),
    ) as Baseline
    if (stored !== null) {
      expect(typeof stored.recordedAt).toBe("string")
      expect(Object.keys(stored.models).length).toBeGreaterThanOrEqual(2)
    }
  })
})
