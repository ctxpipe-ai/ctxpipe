/**
 * identifyPatterns extractor
 *
 * Detects architectural patterns (CQRS, Event Sourcing, Saga, Repository, Factory, etc.)
 * implemented by services in a repository. Uses an LLM agent with list_files, search,
 * and get_file tools to explore code structure, docs, and naming conventions, then
 * produces Pattern objects and IMPLEMENTS_PATTERN claims (Service → Pattern).
 *
 * Uses lower confidence (0.6) than other extractors due to higher hallucination risk
 * when inferring patterns from code structure.
 *
 * Deduplication: pat:${repositoryId}:${root}:${patternName}
 * Claim path: subjectRef = svc:${repositoryId}:${root}, objectRef = pat key
 */

import { HumanMessage } from "@langchain/core/messages"
import { mergeConfigs } from "@langchain/core/runnables"
import { getConfig } from "@langchain/langgraph"
import { tool } from "langchain"
import { z } from "zod/v3"
import { requireCurrentOrgId } from "../../../auth/context.js"
import { getLogger } from "../../../observability/logger.js"
import { getModel } from "../../../retrieval/services/modelProvider.js"
import {
  REPO_EXPLORER_TOOLS_HINT,
  standardRepoExplorerTools,
} from "../../../tools/repoExplorerTools.js"
import { createAgent } from "../../createAgent.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"
import { resolveSubmissionRoot } from "./extractionSubmissionRoot.js"
import {
  partialScanPathsForExtractors,
  partialScanPromptSuffix,
  repoPathMatchesPartialScan,
  shouldSkipExtractorForPartialDeletesOnly,
} from "./partialIngestionScope.js"

/** Normalize pattern name to canonical form for deduplication */
function normalizePatternName(name: string): string {
  const lower = name.toLowerCase().trim()
  const known: Record<string, string> = {
    cqrs: "CQRS",
    "command query responsibility segregation": "CQRS",
    "event sourcing": "Event Sourcing",
    "event-sourcing": "Event Sourcing",
    saga: "Saga",
    "saga pattern": "Saga",
    repository: "Repository",
    "repository pattern": "Repository",
    factory: "Factory",
    "factory pattern": "Factory",
    "abstract factory": "Abstract Factory",
    "unit of work": "Unit of Work",
    "unit-of-work": "Unit of Work",
    "domain events": "Domain Events",
    "domain event": "Domain Events",
    mediator: "Mediator",
    "mediator pattern": "Mediator",
    "outbox pattern": "Outbox",
    outbox: "Outbox",
    "inbox pattern": "Inbox",
    inbox: "Inbox",
    "strangler fig": "Strangler Fig",
    "strangler fig pattern": "Strangler Fig",
    bff: "BFF",
    "back-end for front-end": "BFF",
    "backend for frontend": "BFF",
    "hexagonal architecture": "Hexagonal",
    "ports and adapters": "Hexagonal",
    "clean architecture": "Clean Architecture",
    "vertical slice": "Vertical Slice",
    "vertical slice architecture": "Vertical Slice",
  }
  return known[lower] ?? name
}

type SubmittedPattern = {
  patternName: string
  path: string
  evidence?: string
}

function createIdentifyPatternsTools(capturedPatterns: {
  value: SubmittedPattern[]
}) {
  const submitPatternsTool = tool(
    async ({ patterns }) => {
      capturedPatterns.value.push(...patterns)
      return `Recorded ${patterns.length} pattern(s). Total: ${capturedPatterns.value.length}.`
    },
    {
      name: "submit_patterns",
      description: `Call this when you have discovered one or more architectural patterns implemented by the codebase. For each pattern provide patternName (e.g. CQRS, Event Sourcing, Saga, Repository, Factory, Unit of Work, Domain Events, Outbox, BFF, Hexagonal), path (root or directory where it's implemented, e.g. apps/web or apps/api), and optional evidence (brief description of how you found it). Only report patterns you have concrete evidence for — avoid speculation.`,
      schema: z.object({
        patterns: z.array(
          z.object({
            patternName: z
              .string()
              .describe(
                "Pattern name: CQRS, Event Sourcing, Saga, Repository, Factory, Unit of Work, Domain Events, Outbox, BFF, Hexagonal, etc.",
              ),
            path: z
              .string()
              .describe(
                "Root or directory path where pattern is implemented, e.g. apps/web or .",
              ),
            evidence: z
              .string()
              .optional()
              .describe(
                "Brief evidence, e.g. separate read/write models, event handlers, saga orchestrator",
              ),
          }),
        ),
      }),
    },
  )
  return [...standardRepoExplorerTools, submitPatternsTool]
}

const SYSTEM_PROMPT = `You are analyzing a repository to detect architectural patterns implemented by the codebase. Look for concrete evidence — code structure, docs, naming — not speculation. Higher risk of hallucination: only report patterns you have clear evidence for.

Code structure hints:
| Pattern         | Detection hints |
| CQRS            | Separate read/write models, distinct query vs command handlers, read models, write models |
| Event Sourcing  | Event handlers, event store, append-only event log, event replay, aggregates emitting events |
| Saga            | Saga orchestrator, saga coordinator, compensating transactions, saga steps |
| Repository      | Repository interface/class, data access abstraction, *Repository naming |
| Factory         | Factory class/function, *Factory naming, object creation abstraction |
| Unit of Work    | UnitOfWork, transaction scope, batch commits |
| Domain Events   | DomainEvent, event dispatcher, domain event handlers |
| Outbox          | Outbox table, outbox pattern implementation, transactional outbox |
| BFF             | Backend-for-frontend, BFF layer, API gateway per client |
| Hexagonal       | Ports and adapters, domain in center, infrastructure at edges |

Docs and naming:
- ADR (Architecture Decision Records): docs/adr/, adr/, *.md with "ADR" or "decision"
- README, architecture diagrams: docs/, ARCHITECTURE.md, docs/architecture
- Naming: *Command, *Query, *Event, *Saga, *Repository, *Factory, *Handler

Search strategy:
1. list_files at each root for docs/, adr/, src/, lib/
2. search for pattern-specific terms: CQRS, event sourcing, saga, repository pattern, factory, unit of work, domain event, outbox, BFF, hexagonal
3. search for naming: *Command *Query, *Event, *Saga, *Repository, *Factory
4. get_file on ADRs, README, key source files to confirm

For each pattern found with concrete evidence, call submit_patterns with patternName, path, and optional evidence. Be conservative — avoid false positives. Prefer submit_patterns once ADR/code evidence is clear.`

export async function identifyPatterns(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, roots = ["./"], targetHash } = state
  requireCurrentOrgId()

  if (shouldSkipExtractorForPartialDeletesOnly(state)) {
    return {}
  }

  const scanPaths = partialScanPathsForExtractors(state)
  const scopeHint =
    state.ingestMode === "partial" && scanPaths.length > 0
      ? partialScanPromptSuffix(scanPaths)
      : ""

  const capturedPatterns: { value: SubmittedPattern[] } = { value: [] }
  const tools = createIdentifyPatternsTools(capturedPatterns)
  const agent = createAgent({
    model: getModel("medium", { streaming: false, temperature: 0.1 }),
    tools,
    contextMiddleware: {
      clearToolUsesTriggerTokens: 160_000,
      clearToolUsesKeepMessages: 16,
      summarizationTriggerTokens: 240_000,
      summarizationKeepMessages: 36,
    },
    systemPrompt: `${SYSTEM_PROMPT}

Use repositoryId "${repositoryId}" for all tool calls. Roots to explore: ${roots.join(", ")}.

${REPO_EXPLORER_TOOLS_HINT}${scopeHint}`,
  })

  const userMessage = `Explore the repository for architectural patterns. List files in docs and source directories, search for pattern-specific code and naming. For each pattern found with concrete evidence, read relevant files to confirm, then call submit_patterns. Be conservative — only report patterns you have clear evidence for.`

  await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    mergeConfigs(getConfig(), {
      recursionLimit: 220,
    }),
  )

  if (capturedPatterns.value.length === 0) {
    getLogger().warn(
      "identifyPatterns: agent completed without submit_patterns (no patterns captured)",
      { repositoryId, targetHash },
    )
  }

  let submissions = capturedPatterns.value
  if (state.ingestMode === "partial" && scanPaths.length > 0) {
    submissions = submissions.filter((p) =>
      repoPathMatchesPartialScan(p.path, scanPaths),
    )
  }

  const { objects, claims } = postProcessPatterns(submissions, {
    repositoryId,
    roots,
    targetHash,
  })

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}

/** Post-process captured patterns into objects and claims. Exported for testing. */
export function postProcessPatterns(
  capturedPatterns: SubmittedPattern[],
  state: Pick<CodeIngestionState, "repositoryId" | "roots" | "targetHash">,
): { objects: ExtractedObject[]; claims: ExtractedClaim[] } {
  const { repositoryId, roots = ["./"], targetHash } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []
  const seenPatterns = new Set<string>()

  for (const p of capturedPatterns) {
    const root = resolveSubmissionRoot(p.path, roots)
    if (root === null) continue
    const patternName = normalizePatternName(p.patternName)
    const dedupKey = `pat:${repositoryId}:${root}:${patternName}`
    if (seenPatterns.has(dedupKey)) continue
    seenPatterns.add(dedupKey)

    const svcDeduplicationKey = `svc:${repositoryId}:${root}`

    objects.push({
      kind: "Pattern",
      deduplicationKey: dedupKey,
      name: patternName,
      summary: `${patternName} implemented by ${root}`,
      payload: p.evidence ? { evidence: p.evidence } : undefined,
    })

    claims.push({
      subjectRef: svcDeduplicationKey,
      subjectKind: "Service",
      objectRef: dedupKey,
      objectKind: "Pattern",
      predicate: "IMPLEMENTS_PATTERN",
      sourceId: `identifyPatterns:${repositoryId}:${root}:${patternName}:${targetHash}`,
      sourceType: "git",
      extractionMethod: "llm",
      confidence: 0.6,
      provenance: { root, patternName, evidence: p.evidence },
    })
  }

  return { objects, claims }
}
