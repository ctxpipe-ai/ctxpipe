import { describe, expect, it } from "vitest"
import type { Candidate } from "../../retrieval/schema/candidate.js"
import {
  decisionGate,
  formatDecisionGate,
  withDecisionGate,
} from "./decisionGate.js"

function decision(name: string, status: string, summary = ""): Candidate {
  return {
    id: name,
    sourceChannels: ["semantic"],
    payload: { kind: "Decision", name, summary, status },
  }
}

function instruction(payload: Record<string, unknown>): Candidate {
  return {
    id: String(payload.name),
    sourceChannels: ["semantic"],
    payload: { kind: "InstructionUnit", ...payload },
  }
}

const graphDb = decision(
  "OpenCypher Graph DB and FalkorDB as Default",
  "accepted",
)
const iac = decision("Terraform as our IAC", "accepted")
const apiKeys = decision("Organization-owned MCP API keys", "accepted")

describe("decisionGate", () => {
  it("escalates a high-stakes choice no accepted decision covers", () => {
    const gate = decisionGate(
      "Where should we store operator credentials: 1Password or AWS Secrets Manager?",
      [graphDb, iac, apiKeys],
    )
    expect(gate).toMatchObject({
      needsHuman: true,
      reason: "uncovered",
      category: "security",
    })
  })

  it("does not escalate when an accepted decision covers the topic", () => {
    const gate = decisionGate(
      "Should a new service use Neo4j instead of FalkorDB for graph storage?",
      [graphDb, iac],
    )
    expect(gate).toMatchObject({
      needsHuman: false,
      coveredBy: graphDb.payload.name,
    })
  })

  it("never escalates low-stakes or non-decision prompts that mention scary words", () => {
    for (const prompt of [
      "What's a good name for the helper that formats relative dates in the UI?",
      "Fix the typo in the auth docs heading.",
      "Explain how our OAuth flow works end to end.",
      "Rename the secrets test file to match the module.",
    ]) {
      expect(decisionGate(prompt, [graphDb]).needsHuman, prompt).toBe(false)
    }
  })

  it("does not let superseded or unknown-status decisions cover a topic", () => {
    const prompt = "Should local memory use AgentMemory as its search runtime?"
    const superseded = decision(
      "Local agent memory with repo Markdown and AgentMemory hydrated cache",
      "superseded",
    )
    const noise = decision("AgentMemory format", "unknown")
    expect(decisionGate(prompt, [superseded, noise])).toMatchObject({
      needsHuman: true,
      reason: "uncovered",
    })
    const successor = decision(
      "Markdown-only local memory with candidate-first capture",
      "accepted",
      "ADR-021 wired a hybrid path: repo Markdown plus a disposable local search runtime hydrated from `.ai/memory/`.",
    )
    expect(decisionGate(prompt, [superseded, successor])).toMatchObject({
      needsHuman: false,
      coveredBy: successor.payload.name,
    })
  })

  it("does not treat one shared generic word as coverage", () => {
    const gate = decisionGate(
      "Should we add a Kafka queue between the backend and worker for ingestion events?",
      [
        decision(
          "Code ingestion ReAct agents — recursion limits and context middleware",
          "accepted",
        ),
      ],
    )
    expect(gate).toMatchObject({ needsHuman: true, reason: "uncovered" })
  })

  it("escalates when the only on-topic decision is still proposed", () => {
    const gate = decisionGate("Should we move our queue to Kafka?", [
      decision("Kafka as the ingestion queue", "proposed"),
    ])
    expect(gate).toMatchObject({
      needsHuman: true,
      reason: "proposed",
      related: "Kafka as the ingestion queue",
    })
  })

  it("escalates a correction that may conflict with an accepted decision", () => {
    const gate = decisionGate("Should a new service use Neo4j for its graph?", [
      graphDb,
      instruction({
        name: "Use Neo4j for new graph services",
        summary: "New services should use Neo4j.",
        corrects: "ctx| advised FalkorDB for a new graph service",
      }),
    ])
    expect(gate).toMatchObject({
      needsHuman: true,
      reason: "correction-conflict",
      coveredBy: graphDb.payload.name,
    })
  })

  it("counts a human-maintained rule that requires or forbids something as coverage", () => {
    const prompt =
      "Should we store the Stripe webhook secret in the repo's .env.example?"
    const rule = instruction({
      name: "Never commit secrets to the repository",
      modality: "forbidden",
      source_tier: 1,
    })
    expect(decisionGate(prompt, [rule])).toMatchObject({ needsHuman: false })
    const lesson = instruction({ ...rule.payload, source_tier: 2 })
    expect(decisionGate(prompt, [lesson]).needsHuman).toBe(true)
  })
})

describe("withDecisionGate", () => {
  it("appends the block to the advisor answer only when needed", () => {
    const answer = "**Org standard** — no retrieved decision."
    expect(
      withDecisionGate(
        answer,
        "Where should we store operator credentials: 1Password or AWS Secrets Manager?",
        [],
      ),
    ).toMatch(
      /^\*\*Org standard\*\* — no retrieved decision\.\n\n\*\*Human decision needed\*\*/,
    )
    expect(
      withDecisionGate(answer, "Which region should Railway use?", [
        decision("Railway compute in US East next to Neon", "accepted"),
      ]),
    ).toBe(answer)
  })
})

describe("formatDecisionGate", () => {
  it("renders one block for the agent only when a human decision is needed", () => {
    const gate = decisionGate(
      "Where should we store operator credentials: 1Password or AWS Secrets Manager?",
      [],
    )
    const block = formatDecisionGate(gate)
    expect(block.startsWith("**Human decision needed**")).toBe(true)
    // Ask the person in the session; an ADR is one of their options, not a mandate.
    expect(block).toContain("ask the user")
    expect(block).toMatch(/1\. .*decide now/i)
    expect(block).toMatch(/2\. .*Status: Proposed/)
    expect(block).toMatch(/background run.*option 2/i)
    expect(formatDecisionGate(decisionGate("Rename the helper.", []))).toBe("")
  })
})
