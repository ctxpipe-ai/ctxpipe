import { afterEach, describe, expect, it, vi } from "vitest"
import {
  advisorRuntimeContext,
  mcpAdvisorUserPrompt,
} from "./advisorRuntimeContext.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("advisorRuntimeContext", () => {
  it("names this process deployment.environment and public origin", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv("AUTH_BASE_URL", "https://advisor-pr-19.example.test")

    expect(advisorRuntimeContext()).toBe(
      [
        "This process (runtime metadata, not retrieved documents):",
        "- deployment.environment: pr-19",
        "- public origin: https://advisor-pr-19.example.test",
        "Retrieved documents may mention other environment ids or hosts; those are not this process.",
        "Do not claim this process's environment or origin unless it appears in this block. If this block is absent, say those values are unknown.",
      ].join("\n"),
    )
  })

  it("keeps only the origin from AUTH_BASE_URL", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv(
      "AUTH_BASE_URL",
      "https://preview:s3cret@advisor-pr-19.example.test/mcp?orgSlug=acme",
    )

    const text = advisorRuntimeContext()
    expect(text).toContain(
      "- public origin: https://advisor-pr-19.example.test",
    )
    expect(text).not.toContain("s3cret")
    expect(text).not.toContain("orgSlug")
    expect(text).not.toContain("/mcp")
  })

  it("omits origin when AUTH_BASE_URL is missing or not a URL", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv("AUTH_BASE_URL", "not-a-url")

    const text = advisorRuntimeContext()
    expect(text).toContain("- deployment.environment: pr-19")
    expect(text).not.toContain("public origin")
    expect(text).toContain(
      "If this block is absent, say those values are unknown.",
    )
  })

  it("does not copy process secrets into the advisor prompt", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv("AUTH_BASE_URL", "https://advisor-pr-19.example.test")
    vi.stubEnv("AUTH_SECRET", "super-secret-auth-material-32chars!!")
    vi.stubEnv("DATABASE_URL", "postgres://preview:hunter2@db.example.test/app")

    const text = advisorRuntimeContext()
    expect(text).not.toContain("super-secret-auth-material")
    expect(text).not.toContain("hunter2")
    expect(text).not.toContain("DATABASE_URL")
    expect(text).not.toContain("AUTH_SECRET")
  })
})

describe("mcpAdvisorUserPrompt", () => {
  it("grounds the user turn with runtime metadata before the client prompt", () => {
    vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-19")
    vi.stubEnv("AUTH_BASE_URL", "https://advisor-pr-19.example.test")

    const runtime = [
      "This process (runtime metadata, not retrieved documents):",
      "- deployment.environment: pr-19",
      "- public origin: https://advisor-pr-19.example.test",
      "Retrieved documents may mention other environment ids or hosts; those are not this process.",
      "Do not claim this process's environment or origin unless it appears in this block. If this block is absent, say those values are unknown.",
    ].join("\n")
    expect(
      mcpAdvisorUserPrompt({
        prompt: "Which environment tag is this preview?",
        currentProjectName: "billing",
      }),
    ).toBe(
      `${runtime}\n\nProject: billing\n\nWhich environment tag is this preview?`,
    )
  })
})
