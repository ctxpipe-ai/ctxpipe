import type { Candidate } from "../../retrieval/schema/candidate.js"

/**
 * Deterministic check on a ctx_advisor question: is this a high-stakes choice
 * that no accepted decision covers, so a human must decide before an agent
 * builds on it? Sees only what retrieval returned (ADR-038).
 */
export type DecisionGate = {
  needsHuman: boolean
  reason: "uncovered" | "proposed" | "correction-conflict" | null
  category: StakesCategory | null
  /** Accepted decision or human-maintained rule that settles the question. */
  coveredBy: string | null
  /** Proposed decision, or the correction, behind the escalation. */
  related: string | null
}

type StakesCategory =
  | "security"
  | "personal data"
  | "compliance"
  | "payments"
  | "data model"
  | "architecture"
  | "infrastructure"

/** In priority order: coverage must match the first category the prompt hits. */
const STAKES: Array<[StakesCategory, string[]]> = [
  [
    "security",
    [
      "secret",
      "credential",
      "password",
      "token",
      "api key",
      "signing",
      "encryption",
      "encrypt",
      "auth",
      "authentication",
      "authorization",
      "oauth",
      "saml",
      "sso",
      "permission",
      "rbac",
      "1password",
      "vault",
      "kms",
      "secrets manager",
    ],
  ],
  [
    "personal data",
    [
      "pii",
      "personal data",
      "email",
      "user data",
      "customer data",
      "retention",
      "retain",
      "deletion",
      "delete their",
      "delete customer",
      "delete user",
      "gdpr",
      "anonymise",
      "anonymize",
    ],
  ],
  [
    "compliance",
    [
      "license",
      "licence",
      "licensed",
      "agpl",
      "gpl",
      "soc 2",
      "soc2",
      "hipaa",
      "compliance",
    ],
  ],
  [
    "payments",
    [
      "payment",
      "billing",
      "stripe",
      "paddle",
      "invoice",
      "pricing",
      "subscription",
    ],
  ],
  [
    "data model",
    [
      "database",
      "postgres",
      "mysql",
      "sqlite",
      "schema",
      "migration",
      "orm",
      "drizzle",
      "prisma",
      "graph",
      "neo4j",
      "falkordb",
      "memgraph",
      "neptune",
      "opencypher",
    ],
  ],
  [
    "architecture",
    [
      "queue",
      "broker",
      "kafka",
      "sqs",
      "rabbitmq",
      "pubsub",
      "event bus",
      "runtime",
      "search runtime",
      "bun",
      "node",
      "deno",
      "framework",
      "react",
      "svelte",
      "vue",
      "hono",
      "tailwind",
      "microservice",
      "dependency",
      "library",
      "sdk",
      "vendor",
      "agentmemory",
    ],
  ],
  [
    "infrastructure",
    [
      "region",
      "railway",
      "aws",
      "gcp",
      "azure",
      "cloud provider",
      "terraform",
      "pulumi",
      "cdk",
      "iac",
      "kubernetes",
      "hosting",
      "observability",
      "opentelemetry",
      "analytics",
      "amplitude",
      "posthog",
    ],
  ],
]

/**
 * A question asking whether or what to do ("should…?", "can we…?", "which…
 * should…?"), or an explicit choice. Requests to the assistant ("can you…")
 * and statements or instructions ("fix…", "add a test…") are not decisions.
 */
const DECISION_INTENT = [
  /\b(should|shall|can|could|may|would)\b(?! you\b)[^?]*\?/,
  /\b(choose|pick|select|adopt|standardi[sz]e on)\b/,
  /\binstead of\b|\bvs\.?\s|\bversus\b/,
  /\ballowed to\b/,
]

const STOP = new Set(
  "the and for our you your are was can use used uses using new should would could which what where when how why who there their them they this that these those with from into onto about instead between other than then also just only some any all each per via not but has have had does did doing done make made need want like good best better keep put add run move switch pick choose select adopt replace upgrade store stay stick again first default service backend self data code repo repository project team thing way".split(
    " ",
  ),
)

const SYNONYMS: Record<string, string> = {
  postgresql: "postgres",
  db: "database",
}

function normalize(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/postgresql/g, "postgres")
    .replace(/[^a-z0-9]+/g, " ")} `
}

function has(text: string, term: string): boolean {
  return new RegExp(` ${term}(s|es)? `).test(text)
}

function tokens(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of normalize(text).split(" ")) {
    if (raw.length < 3 || STOP.has(raw)) continue
    const word =
      SYNONYMS[raw] ??
      (raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss")
        ? raw.slice(0, -1)
        : raw)
    if (!STOP.has(word)) out.add(word)
  }
  return out
}

type Topic = { category: StakesCategory; terms: string[]; words: Set<string> }

function topicOf(prompt: string): Topic | null {
  const lower = prompt.toLowerCase()
  if (!DECISION_INTENT.some((re) => re.test(lower))) return null
  const text = normalize(prompt)
  for (const [category, vocabulary] of STAKES) {
    const matched = vocabulary.filter((term) => has(text, term))
    // Longest match wins: "search runtime" must not also count as "runtime".
    const terms = matched.filter(
      (term) =>
        !matched.some((other) => other !== term && other.includes(term)),
    )
    if (terms.length > 0) return { category, terms, words: tokens(prompt) }
  }
  return null
}

/**
 * The title names the topic, or shares two words with the prompt while the
 * summary names the topic. Summaries mention products in passing (the
 * Terraform ADR names Railway), so a summary alone never makes a decision
 * on-topic.
 */
function isOnTopic(topic: Topic, title: string, summary: string): boolean {
  const t = normalize(title)
  if (topic.terms.some((term) => has(t, term))) return true
  const shared = [...tokens(title)].filter((w) => topic.words.has(w))
  const s = normalize(summary)
  return shared.length >= 2 && topic.terms.some((term) => has(s, term))
}

function text(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  return typeof value === "string" ? value : ""
}

export function decisionGate(
  prompt: string,
  candidates: Candidate[],
): DecisionGate {
  const topic = topicOf(prompt)
  const none: DecisionGate = {
    needsHuman: false,
    reason: null,
    category: topic?.category ?? null,
    coveredBy: null,
    related: null,
  }
  if (!topic) return none

  let covering: string | null = null
  let proposed: string | null = null
  let correction: string | null = null
  for (const { payload } of candidates) {
    const kind = text(payload, "kind")
    const name = text(payload, "name")
    const onTopic = isOnTopic(topic, name, text(payload, "summary"))
    if (kind === "Decision" && onTopic) {
      const status = text(payload, "status").toLowerCase()
      if (status === "accepted" || status === "approved") covering ??= name
      else if (status === "proposed" || status === "draft") proposed ??= name
    }
    if (kind === "InstructionUnit") {
      const corrects = text(payload, "corrects")
      if (corrects && (onTopic || isOnTopic(topic, corrects, "")))
        correction ??= corrects
      else if (
        onTopic &&
        payload.source_tier === 1 &&
        ["required", "forbidden"].includes(text(payload, "modality"))
      ) {
        covering ??= name
      }
    }
  }

  if (covering && correction) {
    return {
      needsHuman: true,
      reason: "correction-conflict",
      category: topic.category,
      coveredBy: covering,
      related: correction,
    }
  }
  if (covering) return { ...none, coveredBy: covering }
  if (proposed) {
    return {
      needsHuman: true,
      reason: "proposed",
      category: topic.category,
      coveredBy: null,
      related: proposed,
    }
  }
  return {
    needsHuman: true,
    reason: "uncovered",
    category: topic.category,
    coveredBy: null,
    related: null,
  }
}

/** The advisor answer with the gate's block appended when a human must decide. */
export function withDecisionGate(
  answer: string,
  prompt: string,
  candidates: Candidate[],
): string {
  const block = formatDecisionGate(decisionGate(prompt, candidates))
  return block ? `${answer}\n\n${block}` : answer
}

/** Block appended to the MCP answer; empty when no human decision is needed. */
export function formatDecisionGate(gate: DecisionGate): string {
  if (!gate.needsHuman) return ""
  const why =
    gate.reason === "proposed"
      ? `the only decision on this is still proposed ("${gate.related}"); its owner must accept it first`
      : gate.reason === "correction-conflict"
        ? `an engineer's correction ("${gate.related}") may conflict with accepted decision "${gate.coveredBy}"; confirm which holds`
        : "no accepted decision in ctx| covers this"
  return `**Human decision needed** (${gate.category}): ${why}. Do not build on a choice yet. Record your recommendation as a proposed decision (Status: Proposed) in the pull request and get the owning team's approval first.`
}
