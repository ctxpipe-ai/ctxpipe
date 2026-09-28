import { describe, expect, it } from "vitest"
import {
  agentSetup,
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
