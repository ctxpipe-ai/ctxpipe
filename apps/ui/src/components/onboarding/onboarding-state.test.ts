import { describe, expect, it } from "vitest"
import {
  agentSetup,
  type BeatState,
  contextRepoStage,
  deriveOnboardingView,
  findCreatedContextRepo,
  type OnboardingFacts,
  type OnboardingStepId,
  orgNameFromEmail,
  reopenAs,
  slugify,
  stepBefore,
  titleAction,
} from "./onboarding-state"

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    orgSlug: "acme",
    typedSlug: "",
    isJoiner: false,
    github: {
      installed: false,
      skipped: false,
      repositories: [],
      queued: false,
      continued: false,
      activeCount: 0,
      readyCount: 0,
      failedCount: 0,
      stepLabel: null,
    },
    agent: { firstCall: null, skipped: false },
    ...overrides,
  }
}

describe("deriveOnboardingView", () => {
  it("starts on the org beat and labels the frame with the typed slug", () => {
    const view = deriveOnboardingView(
      facts({ orgSlug: null, typedSlug: "acme-eng" }),
    )
    expect(view.current).toBe("org")
    expect(view.beats).toEqual({
      org: "current",
      source: "future",
      agent: "future",
    })
    expect(view.frameLabel).toBe("acme-eng")
  })

  it("moves to the agent beat once a repository is queued, while indexing continues", () => {
    const view = deriveOnboardingView(
      facts({
        github: {
          installed: true,
          skipped: false,
          repositories: ["acme/api"],
          queued: true,
          continued: true,
          activeCount: 1,
          readyCount: 0,
          failedCount: 0,
          stepLabel: "embedding 7/22",
        },
      }),
    )
    expect(view.current).toBe("agent")
    expect(view.beats.source).toBe("done")
    expect(view.indexingLabel).toBe("embedding 7/22")
  })

  it("marks GitHub skipped and still opens the agent beat", () => {
    const view = deriveOnboardingView(
      facts({ github: { ...facts().github, skipped: true } }),
    )
    expect(view.beats.source).toBe("skipped")
    expect(view.current).toBe("agent")
  })

  it("completes only on a recorded first MCP call", () => {
    const view = deriveOnboardingView(
      facts({
        github: {
          ...facts().github,
          repositories: ["acme/api"],
          continued: true,
          readyCount: 1,
        },
        agent: {
          firstCall: { client: "claude-code", tool: "ctx_advisor" },
          skipped: false,
        },
      }),
    )
    expect(view.current).toBeNull()
    expect(view.beats.agent).toBe("done")
    expect(view.caption).toContain("claude-code")
  })

  it("gives joiners only the agent beat", () => {
    const view = deriveOnboardingView(facts({ isJoiner: true }))
    expect(view.current).toBe("agent")
    expect(view.beats.org).toBe("done")
    expect(view.beats.source).toBe("future")
  })
})

it("keeps the GitHub step open after indexing starts, until Continue", () => {
  const indexing = {
    ...facts().github,
    installed: true,
    repositories: ["acme/api"],
    queued: true,
    activeCount: 1,
  }
  const before = deriveOnboardingView(facts({ github: indexing }))
  expect(before.current).toBe("source")
  expect(before.hasSource).toBe(true)
  const after = deriveOnboardingView(
    facts({ github: { ...indexing, continued: true } }),
  )
  expect(after.current).toBe("agent")
  expect(after.beats.source).toBe("done")
})

describe("slugify", () => {
  it("lowercases, hyphenates and caps at 32 characters", () => {
    expect(slugify("  Acme Engineering! ")).toBe("acme-engineering")
    expect(slugify("x".repeat(40))).toHaveLength(32)
  })
})

describe("agentSetup", () => {
  it("points every option at this deployment", () => {
    const hosted = agentSetup("https://app.ctxpipe.ai", "acme")
    expect(hosted.cli).toBe("npx ctxpipe init --org acme")
    const preview = agentSetup("https://pr-361.example.com", "acme")
    expect(preview.cli).toBe(
      "npx ctxpipe init --org acme --base-url https://pr-361.example.com",
    )
    expect(preview.claude).toContain(
      '"https://pr-361.example.com/mcp?orgSlug=acme"',
    )
    expect(preview.json).toContain(
      "https://pr-361.example.com/mcp?orgSlug=acme",
    )
  })
})

describe("step navigation", () => {
  const admin = { isJoiner: false }
  const joiner = { isJoiner: true }
  const beats = (
    org: BeatState,
    source: BeatState,
    agent: BeatState,
  ): Record<OnboardingStepId, BeatState> => ({ org, source, agent })

  it("goes back one step, skipping GitHub for joiners", () => {
    expect(stepBefore("source", admin)).toBe("org")
    expect(stepBefore("agent", admin)).toBe("source")
    expect(stepBefore("agent", joiner)).toBe("org")
  })

  it("un-skips a skipped step instead of reviewing it", () => {
    expect(
      reopenAs("source", { beats: beats("done", "skipped", "current") }),
    ).toBe("unskip")
    expect(
      reopenAs("source", { beats: beats("done", "done", "current") }),
    ).toBe("review")
    expect(reopenAs("org", { beats: beats("done", "done", "current") })).toBe(
      "review",
    )
  })

  it("on step 3: done titles open, the current title does nothing", () => {
    const nav = {
      open: "agent" as const,
      current: "agent" as const,
      beats: beats("done", "done", "current"),
      isJoiner: false,
    }
    expect(titleAction("org", nav)).toBe("open")
    expect(titleAction("source", nav)).toBe("open")
    expect(titleAction("agent", nav)).toBeNull()
  })

  it("reviewing step 1 from step 3: its title closes, step 3's returns", () => {
    const nav = {
      open: "org" as const,
      current: "agent" as const,
      beats: beats("done", "done", "current"),
      isJoiner: false,
    }
    expect(titleAction("org", nav)).toBe("close")
    expect(titleAction("agent", nav)).toBe("return")
    expect(titleAction("source", nav)).toBe("open")
  })

  it("does nothing for a future step", () => {
    const nav = {
      open: "source" as const,
      current: "source" as const,
      beats: beats("done", "current", "future"),
      isJoiner: false,
    }
    expect(titleAction("agent", nav)).toBeNull()
  })

  it("all done: every title opens its step, and its own title closes it", () => {
    const done = beats("done", "done", "done")
    expect(
      titleAction("agent", {
        open: null,
        current: null,
        beats: done,
        isJoiner: false,
      }),
    ).toBe("open")
    expect(
      titleAction("agent", {
        open: "agent",
        current: null,
        beats: done,
        isJoiner: false,
      }),
    ).toBe("close")
  })
})

describe("context repository", () => {
  const started = {
    startedAt: Date.parse("2026-10-01T03:00:00Z"),
    knownIds: [1, 2],
    shareOpened: false,
  }

  it("moves create, share (selected repositories only), waiting, found", () => {
    expect(
      contextRepoStage({ found: false, progress: null, grantsAll: false }),
    ).toBe("create")
    expect(
      contextRepoStage({ found: false, progress: started, grantsAll: false }),
    ).toBe("share")
    expect(
      contextRepoStage({ found: false, progress: started, grantsAll: true }),
    ).toBe("waiting")
    expect(
      contextRepoStage({
        found: false,
        progress: { ...started, shareOpened: true },
        grantsAll: false,
      }),
    ).toBe("waiting")
    expect(
      contextRepoStage({ found: true, progress: started, grantsAll: false }),
    ).toBe("found")
  })

  it("finds the newest repository created since they started, whatever its name", () => {
    const repos = [
      { id: 1, created_at: "2025-01-01T00:00:00Z" },
      { id: 3, created_at: "2026-10-01T03:02:00Z" },
      { id: 4, created_at: "2026-10-01T03:05:00Z" },
    ]
    expect(findCreatedContextRepo(repos, started)?.id).toBe(4)
    expect(findCreatedContextRepo(repos, null)).toBeUndefined()
    // An old repository shared now is not mistaken for the new one.
    expect(
      findCreatedContextRepo([repos[0] as (typeof repos)[number]], started),
    ).toBeUndefined()
  })

  it("falls back to a newly shared id when GitHub gives no creation time", () => {
    const repos = [
      { id: 2, created_at: null },
      { id: 9, created_at: null },
    ]
    expect(findCreatedContextRepo(repos, started)?.id).toBe(9)
  })
})

describe("orgNameFromEmail", () => {
  it("names the organisation after a work domain", () => {
    expect(orgNameFromEmail("tom@trurec.ai")).toBe("Trurec")
    expect(orgNameFromEmail("a@eng.acme.co.uk")).toBe("Acme")
    expect(orgNameFromEmail("a@Acme.COM")).toBe("Acme")
  })

  it("suggests nothing for personal mail or a missing address", () => {
    expect(orgNameFromEmail("someone@gmail.com")).toBe("")
    expect(orgNameFromEmail("someone@outlook.co.uk")).toBe("")
    expect(orgNameFromEmail("someone@proton.me")).toBe("")
    expect(orgNameFromEmail(undefined)).toBe("")
    expect(orgNameFromEmail("no-at-sign")).toBe("")
  })
})
