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
    /**
     * They pressed Continue (or Set up later) on the GitHub step, or arrived
     * with a context repository already set. Indexing starts on its own, so
     * the step stays open for the context repository until then.
     */
    continued: boolean
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
  /** The frame shows "your-org" until a slug is typed. */
  framePlaceholder: boolean
  /** Mono line under the context layer. */
  indexingLabel: string
  caption: string
}

export function repositoryCount(n: number) {
  return `${n} ${n === 1 ? "repository" : "repositories"}`
}

export function deriveOnboardingView(facts: OnboardingFacts): OnboardingView {
  const { github, agent } = facts
  const orgDone = facts.orgSlug !== null
  const hasSource = github.repositories.length > 0 || github.queued
  // Joiners cannot connect GitHub themselves; an unconnected org reads as
  // skipped for them rather than as a step they are stuck on.
  const sourceSettled =
    (hasSource && github.continued) || github.skipped || facts.isJoiner
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
    source: beat(
      "source",
      hasSource && github.continued,
      github.skipped && !hasSource,
    ),
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
    framePlaceholder: facts.orgSlug === null && facts.typedSlug.trim() === "",
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

/**
 * A starting organisation name from a work email: tom@trurec.ai gives
 * "Trurec". Personal mail providers give nothing, since the domain says
 * nothing about the team.
 */
export function orgNameFromEmail(email: string | null | undefined): string {
  const domain = email?.split("@")[1]?.trim().toLowerCase()
  if (!domain) return ""
  const labels = domain.split(".").filter(Boolean)
  // Drop the public suffix: the last label, plus a generic second level
  // such as co.uk or com.au.
  labels.pop()
  if (
    labels.length > 1 &&
    ["co", "com", "org", "net", "ac", "gov", "edu"].includes(
      labels.at(-1) ?? "",
    )
  ) {
    labels.pop()
  }
  const name = labels.at(-1)
  if (!name || PERSONAL_MAIL_DOMAINS.has(name)) return ""
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "proton",
  "protonmail",
  "pm",
  "gmx",
  "mail",
  "yandex",
  "zoho",
  "fastmail",
  "hey",
  "tutanota",
  "qq",
  "163",
  "example",
])

/** Commands and config for connecting an agent to this deployment. */
export function agentSetup(origin: string, orgSlug: string) {
  const mcpUrl = `${origin}/mcp?orgSlug=${orgSlug}`
  const baseUrlFlag =
    origin === "https://app.ctxpipe.ai" ? "" : ` --base-url ${origin}`
  return {
    cli: `npx ctxpipe init --org ${orgSlug}${baseUrlFlag}`,
    claude: `claude mcp add --transport http ctxpipe --scope user "${mcpUrl}"`,
    json: `{
  "mcpServers": {
    "ctxpipe": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`,
  }
}

/**
 * Going back and forward. `open` is the step shown on the left: a reopened
 * earlier step, or the current one. Reopening never undoes anything; a
 * skipped step is un-skipped instead, which makes it current again.
 */
export type StepNavigation = {
  open: OnboardingStepId | null
  current: OnboardingStepId | null
  beats: Record<OnboardingStepId, BeatState>
  /** Members cannot change GitHub, so their Back skips it. */
  isJoiner: boolean
}

/** The step Back from `id` opens. */
export function stepBefore(
  id: "source" | "agent",
  nav: Pick<StepNavigation, "isJoiner">,
): OnboardingStepId {
  return id === "agent" && !nav.isJoiner ? "source" : "org"
}

/** How opening `id` works: show it again, or un-skip it. */
export function reopenAs(
  id: OnboardingStepId,
  nav: Pick<StepNavigation, "beats">,
): "review" | "unskip" {
  return nav.beats[id] === "skipped" ? "unskip" : "review"
}

/**
 * What pressing a step's title does. The open step's title closes it back
 * to the current step; the current step's title returns to it; a done or
 * skipped step's title opens it. A future step does nothing.
 */
export function titleAction(
  id: OnboardingStepId,
  nav: StepNavigation,
): "close" | "return" | "open" | null {
  if (nav.open === id) return id === nav.current ? null : "close"
  if (id === nav.current) return "return"
  if (nav.beats[id] === "done" || nav.beats[id] === "skipped") return "open"
  return null
}

/** Set when they start creating a context repository; kept across reloads. */
export type ContextRepoProgress = {
  startedAt: number
  /** Repository ids GitHub already shared when they started. */
  knownIds: number[]
  /** They opened GitHub's page to share the new repository with ctx|. */
  shareOpened: boolean
}

export type ContextRepoStage = "create" | "share" | "waiting" | "found"

/**
 * Where the context repository sub-steps are. Sharing is only a step when
 * GitHub shares selected repositories: a new repository is invisible to
 * ctx| until it is shared.
 */
export function contextRepoStage(input: {
  found: boolean
  progress: ContextRepoProgress | null
  grantsAll: boolean
}): ContextRepoStage {
  if (input.found) return "found"
  if (!input.progress) return "create"
  if (!input.grantsAll && !input.progress.shareOpened) return "share"
  return "waiting"
}

/**
 * The repository they created after starting, whatever they named it: the
 * newest one created since then (a minute's grace for clock skew). Without a
 * creation time, a repository GitHub did not share before counts.
 */
export function findCreatedContextRepo<
  T extends { id: number; created_at: string | null },
>(repos: readonly T[], progress: ContextRepoProgress | null): T | undefined {
  if (!progress) return undefined
  const known = new Set(progress.knownIds)
  const createdAt = (repo: T) =>
    repo.created_at ? Date.parse(repo.created_at) : Number.NaN
  return repos
    .filter((repo) => {
      const at = createdAt(repo)
      return Number.isFinite(at)
        ? at >= progress.startedAt - 60_000
        : !known.has(repo.id)
    })
    .sort((a, b) => (createdAt(b) || 0) - (createdAt(a) || 0))[0]
}
