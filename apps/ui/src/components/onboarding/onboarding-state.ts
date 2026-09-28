/**
 * One picture, three beats. Every beat is derived from something that
 * happened in the account (org created, GitHub installed, repositories
 * queued, first MCP call recorded) or an explicit skip, never from a Next
 * button. Only the current beat animates.
 */

export type BeatState = "future" | "current" | "done" | "skipped"

export type OnboardingStepId = "org" | "source" | "agent"

export type OnboardingFacts = {
  /** Slug of the org this onboarding is for, once it exists. */
  orgSlug: string | null
  /** What the admin has typed into the slug field so far. */
  typedSlug: string
  /** Joiners arrive with the org made and only the agent beat open. */
  isJoiner: boolean
  github: {
    installed: boolean
    skipped: boolean
    /** Repository names ctx| has queued or indexed. */
    repositories: string[]
    /** Saved a selection this session; the list may not show it yet. */
    queued: boolean
    activeCount: number
    readyCount: number
    failedCount: number
    /** e.g. `embedding 7/22` when exactly one repository is running. */
    stepLabel: string | null
  }
  agent: {
    firstCall: { client: string | null; tool: string | null } | null
    skipped: boolean
  }
}

export type OnboardingView = {
  current: OnboardingStepId | null
  beats: Record<OnboardingStepId, BeatState>
  hasSource: boolean
  frameLabel: string
  /** Mono line under the context layer. */
  indexingLabel: string
  caption: string
}

function repositoryCount(n: number) {
  return `${n} ${n === 1 ? "repository" : "repositories"}`
}

export function deriveOnboardingView(facts: OnboardingFacts): OnboardingView {
  const { github, agent } = facts
  const orgDone = facts.orgSlug !== null
  const hasSource = github.repositories.length > 0 || github.queued
  // Joiners cannot connect GitHub themselves; an unconnected org reads as
  // skipped for them rather than as a step they are stuck on.
  const sourceSettled = hasSource || github.skipped || facts.isJoiner
  const agentSettled = agent.firstCall !== null || agent.skipped

  const current: OnboardingStepId | null = !orgDone
    ? "org"
    : !sourceSettled
      ? "source"
      : !agentSettled
        ? "agent"
        : null

  const beat = (
    id: OnboardingStepId,
    done: boolean,
    skipped: boolean,
  ): BeatState =>
    done ? "done" : skipped ? "skipped" : current === id ? "current" : "future"

  const beats = {
    org: beat("org", orgDone, false),
    // A joiner's unconnected GitHub is their admin's to do, not a skip.
    source: beat("source", hasSource, github.skipped && !hasSource),
    agent: beat("agent", agent.firstCall !== null, agent.skipped),
  }

  const indexingLabel =
    github.activeCount > 0
      ? (github.stepLabel ?? `indexing ${repositoryCount(github.activeCount)}`)
      : github.readyCount > 0
        ? `${repositoryCount(github.readyCount)} indexed`
        : github.failedCount > 0
          ? `${repositoryCount(github.failedCount)} need attention`
          : hasSource
            ? `queued ${repositoryCount(github.repositories.length)}`
            : "nothing indexed yet"

  const first = github.repositories[0] ?? "Your selection"
  const clientName = agent.firstCall?.client ?? "Your agent"
  const caption = (() => {
    if (current === "org") {
      return "Nothing is connected yet. Your organisation’s slug goes on the frame."
    }
    if (current === "source") {
      return github.installed
        ? "GitHub is connected. Choose the repositories ctx| should index."
        : "Next, a repository flows into the context layer. Nothing is indexed yet."
    }
    if (current === "agent") {
      return hasSource
        ? `${first} is in the context layer. Waiting for your agent’s first call.`
        : "No source is connected, so your agent would get empty answers. Waiting for its first call."
    }
    if (beats.agent === "done") {
      return hasSource
        ? `${clientName} called ctx| and can answer from ${first}.`
        : `${clientName} is connected. It has nothing to answer from until a repository is indexed.`
    }
    if (hasSource)
      return "Your repositories are in ctx|. No agent is connected yet."
    return "Only the organisation is set up. The rest stays dark until you connect it."
  })()

  return {
    current,
    beats,
    hasSource,
    frameLabel: facts.orgSlug ?? (facts.typedSlug.trim() || "your-org"),
    indexingLabel,
    caption,
  }
}

const SLUG_MAX_LENGTH = 32

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
}

export function mcpConfigSnippet(orgSlug: string): string {
  return `{
  "mcpServers": {
    "ctxpipe": {
      "type": "http",
      "url": "https://app.ctxpipe.ai/mcp?orgSlug=${orgSlug}"
    }
  }
}`
}
