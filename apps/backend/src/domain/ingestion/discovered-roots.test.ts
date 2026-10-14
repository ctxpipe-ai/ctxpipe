import { describe, expect, it } from "vitest"
import { resolveDiscoveredRoots } from "./discovered-roots.js"

const SCRIPT = {
  roots: [
    {
      path: "apps/api",
      manifests: ["package.json"],
      evidence: ["pnpm-workspace.yaml"],
    },
    {
      path: "apps/web",
      manifests: ["package.json"],
      evidence: ["pnpm-workspace.yaml"],
    },
  ],
  ambiguous: [
    {
      manifest: null,
      reason: "No workspace manifest names these folders",
      candidates: [
        { path: "services/worker", manifests: ["go.mod"] },
        { path: "examples/basic", manifests: ["package.json"] },
      ],
    },
  ],
  skipped: [],
}

describe("resolveDiscoveredRoots", () => {
  it("keeps each script root and adds only the candidates that the model chose", () => {
    const model = {
      roots: [
        // The model drops apps/web and changes the manifests of apps/api.
        { path: "apps/api", manifests: ["Cargo.toml"], evidence: ["model"] },
        { path: "services/worker", manifests: [], evidence: ["guess"] },
      ],
      ambiguous: [],
      skipped: [],
    }
    expect(resolveDiscoveredRoots(SCRIPT, model)).toEqual({
      roots: [
        SCRIPT.roots[0],
        SCRIPT.roots[1],
        {
          path: "services/worker",
          manifests: ["go.mod"],
          evidence: ["model"],
        },
      ],
      refused: [],
    })
  })

  it("refuses a path outside the checkout and a folder that is not a candidate", () => {
    const model = {
      roots: [
        { path: "../x", manifests: [], evidence: ["model"] },
        { path: "docs/site", manifests: ["package.json"], evidence: ["model"] },
        { path: "apps/bad\n`x", manifests: [], evidence: ["model"] },
      ],
      ambiguous: [],
    }
    const result = resolveDiscoveredRoots(SCRIPT, model)
    expect(result.roots).toEqual(SCRIPT.roots)
    expect(result.refused).toEqual([
      { path: "../x", reason: "The path is not safe to write" },
      {
        path: "docs/site",
        reason: "The path is not a candidate of an ambiguous entry",
      },
      { path: "apps/bad\n`x", reason: "The path is not safe to write" },
    ])
  })

  it("gives the script roots when there is no model result or it has a bad shape", () => {
    expect(resolveDiscoveredRoots(SCRIPT, null)).toEqual({
      roots: SCRIPT.roots,
      refused: [],
    })
    expect(resolveDiscoveredRoots(SCRIPT, { roots: "all" })).toEqual({
      roots: SCRIPT.roots,
      refused: [
        {
          path: null,
          reason: "The model result does not match the discover-roots schema",
        },
      ],
    })
  })

  it("refuses an unsafe script root and fails on a script result with a bad shape", () => {
    const script = {
      ...SCRIPT,
      roots: [...SCRIPT.roots, { path: "a/../b", manifests: [], evidence: [] }],
    }
    expect(resolveDiscoveredRoots(script, null)).toEqual({
      roots: SCRIPT.roots,
      refused: [{ path: "a/../b", reason: "The path is not safe to write" }],
    })
    expect(() => resolveDiscoveredRoots({ roots: [] }, null)).toThrow(
      "The discover-roots script result does not match its schema",
    )
  })

  it("refuses a path with a C1 control, a line separator, or an invisible direction character", () => {
    const bad = [
      ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
      0x2028,
      0x2029,
      0x061c,
      ...[0x200b, 0x200c, 0x200d],
      0x200e,
      0x200f,
      ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
      ...[0x2066, 0x2067, 0x2068, 0x2069],
    ].map((code) => String.fromCodePoint(code))
    for (const char of bad) {
      const path = `apps/a${char}b`
      const script = {
        ...SCRIPT,
        roots: [...SCRIPT.roots, { path, manifests: [], evidence: [] }],
      }
      expect(resolveDiscoveredRoots(script, null).refused).toEqual([
        { path, reason: "The path is not safe to write" },
      ])
    }
    const path = "apps/caf\u00e9"
    expect(
      resolveDiscoveredRoots(
        { ...SCRIPT, roots: [{ path, manifests: [], evidence: [] }] },
        null,
      ).refused,
    ).toEqual([])
  })
})
