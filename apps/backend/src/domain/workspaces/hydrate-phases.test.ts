import { describe, expect, it } from "vitest"
import {
  effectiveValidFrom,
  hydrateHasPendingWork,
  hydratePostgresIsComplete,
  initialHydratePhases,
  looksLikeGitSha,
  markHydratePhase,
  pendingHydratePhases,
} from "./hydrate-phases.js"

describe("hydrate phases", () => {
  it("treats hex SHAs as missing valid_from and keeps timestamps", () => {
    expect(looksLikeGitSha("abc123")).toBe(true)
    expect(looksLikeGitSha("2026-01-01")).toBe(false)
    expect(looksLikeGitSha("2026-01-01T00:00:00.000Z")).toBe(false)
    expect(
      effectiveValidFrom({
        recorded: "abc123",
        introducingCommitTimestamp: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe("2026-08-16T12:00:00.000Z")
    expect(
      effectiveValidFrom({
        recorded: "2026-01-01",
        introducingCommitTimestamp: "2026-08-16T12:00:00.000Z",
      }),
    ).toBe("2026-01-01")
  })

  it("compares projection completeness by URL and SHA", () => {
    expect(
      hydratePostgresIsComplete({
        activeProjectionUrl: "https://github.com/acme/a",
        activeProjectionSha: "aaa",
        desiredUrl: "https://github.com/acme/b",
        desiredSha: "aaa",
      }),
    ).toBe(false)
    expect(
      hydratePostgresIsComplete({
        activeProjectionUrl: "https://github.com/acme/b",
        activeProjectionSha: "aaa",
        desiredUrl: "https://github.com/acme/b",
        desiredSha: "aaa",
      }),
    ).toBe(true)
  })

  it("retries incomplete derived phases on the same SHA", () => {
    const pending = pendingHydratePhases({
      desiredUrl: "https://github.com/acme/docs",
      desiredSha: "abc",
      activeProjectionUrl: "https://github.com/acme/docs",
      activeProjectionSha: "abc",
      indexedSha: "abc",
      phases: {
        url: "https://github.com/acme/docs",
        sha: "abc",
        embeddings: false,
      },
    })
    expect(pending).toEqual({
      postgres: false,
      embeddings: true,
      index: false,
    })
    expect(hydrateHasPendingWork(pending)).toBe(true)
  })

  it("resets derived phases when URL or SHA moved", () => {
    expect(
      pendingHydratePhases({
        desiredUrl: "https://github.com/acme/b",
        desiredSha: "bbb",
        activeProjectionUrl: "https://github.com/acme/a",
        activeProjectionSha: "aaa",
        indexedSha: "aaa",
        phases: {
          url: "https://github.com/acme/a",
          sha: "aaa",
          embeddings: true,
        },
      }),
    ).toEqual({
      postgres: true,
      embeddings: true,
      index: true,
    })
  })

  it("marks a derived phase complete on the same key", () => {
    const started = initialHydratePhases({
      url: "https://github.com/acme/docs",
      sha: "abc",
    })
    expect(started.embeddings).toBe(false)
    expect(markHydratePhase(started, "embeddings").embeddings).toBe(true)
  })
})
