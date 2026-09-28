import { describe, expect, it } from "vitest"
import {
  deriveOnboardingView,
  type OnboardingFacts,
  slugify,
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

describe("slugify", () => {
  it("lowercases, hyphenates and caps at 32 characters", () => {
    expect(slugify("  Acme Engineering! ")).toBe("acme-engineering")
    expect(slugify("x".repeat(40))).toHaveLength(32)
  })
})
