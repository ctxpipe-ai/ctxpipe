import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../../domain/codeIngestion/evidenceSourceId.js"
import type { ExtractedClaim, ExtractedObject } from "../schemas.js"

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ deduplicationKey: string }>,
  selectCalls: 0,
}))

vi.mock("../../../db/client.js", () => ({
  getOrgDb: () => ({
    select: () => {
      mocks.selectCalls += 1
      return {
        from: () => ({
          where: async () => mocks.rows,
        }),
      }
    },
  }),
}))

import {
  asLocatedPath,
  fileDedupKey,
  linkLocatedPaths,
  matchPackageForPath,
  parsePackageDedupKey,
  resolveReferenceClaims,
} from "./linkLocatedPaths.js"

const repositoryId = "repo_api"
const targetHash = "abc"

function unit(
  path: string,
  key = "inu:repo_api:apps/backend:1",
): ExtractedObject {
  return {
    kind: "InstructionUnit",
    deduplicationKey: key,
    name: "Use services",
    summary: "Put logic in a service",
    payload: { path, root: "apps/backend" },
  }
}

function service(root: string): ExtractedObject {
  return {
    kind: "Service",
    deduplicationKey: `svc:${repositoryId}:${root}`,
    name: root,
    summary: `Service at ${root}`,
  }
}

function kindClaim(root: string, configPath: string): ExtractedClaim {
  return {
    subjectRef: `svc:${repositoryId}:${root}`,
    subjectKind: "Service",
    objectRef: repositoryId,
    objectKind: "Repository",
    predicate: "IMPLEMENTED_IN",
    sourceId: `extractKind:${repositoryId}:${root}:${targetHash}`,
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: 0.9,
    provenance: { root, configPath },
  }
}

describe("linkLocatedPaths", () => {
  it("locates instruction units on a shared File with PART_OF and DECLARED_IN", () => {
    const { extractedObjects, extractedClaims } = linkLocatedPaths({
      repositoryId,
      targetHash,
      objects: [
        service("apps/backend"),
        unit("apps/backend/AGENTS.md", "inu:repo_api:apps/backend:a"),
        unit("./apps/backend/AGENTS.md", "inu:repo_api:apps/backend:b"),
      ],
      claims: [],
    })

    expect(extractedObjects).toEqual([
      expect.objectContaining({
        kind: "File",
        deduplicationKey: fileDedupKey(repositoryId, "apps/backend/AGENTS.md"),
        summary: "File at apps/backend/AGENTS.md",
        payload: { path: "apps/backend/AGENTS.md" },
      }),
    ])
    expect(extractedClaims.map((claim) => claim.predicate).sort()).toEqual([
      "DECLARED_IN",
      "DECLARED_IN",
      "PART_OF",
      "PART_OF",
    ])
    expect(
      extractedClaims.some(
        (claim) =>
          claim.subjectKind === "File" &&
          claim.predicate === "PART_OF" &&
          claim.objectRef === `svc:${repositoryId}:apps/backend`,
      ),
    ).toBe(true)
    expect(extractedClaims.some((claim) => claim.predicate === "ABOUT")).toBe(
      false,
    )
    for (const claim of extractedClaims) {
      expect(
        isConventionalEvidenceSourceId(
          claim.sourceId,
          repositoryId,
          targetHash,
        ),
      ).toBe(true)
    }
  })

  it("locates Decisions on their File too", () => {
    const { extractedClaims } = linkLocatedPaths({
      repositoryId,
      targetHash,
      objects: [
        {
          kind: "Decision",
          deduplicationKey: `dec:${repositoryId}:docs/adr/0007-x.md`,
          name: "ADR-0007",
          payload: { path: "docs/adr/0007-x.md" },
        },
      ],
      claims: [],
    })
    expect(
      extractedClaims.some(
        (claim) =>
          claim.subjectKind === "Decision" &&
          claim.predicate === "DECLARED_IN" &&
          claim.objectRef === fileDedupKey(repositoryId, "docs/adr/0007-x.md"),
      ),
    ).toBe(true)
  })

  it("locates extractKind config paths and skips connector and HTTP paths", () => {
    const { extractedObjects, extractedClaims } = linkLocatedPaths({
      repositoryId,
      targetHash,
      objects: [service("apps/backend")],
      claims: [
        kindClaim("apps/backend", "apps/backend/package.json"),
        {
          ...kindClaim("apps/backend", "linear/issues/foo--1.md"),
          provenance: { path: "linear/issues/foo--1.md" },
        },
        {
          ...kindClaim("apps/backend", "/users"),
          provenance: { path: "/users" },
        },
      ],
    })

    expect(extractedObjects.map((object) => object.deduplicationKey)).toEqual([
      fileDedupKey(repositoryId, "apps/backend/package.json"),
    ])
    expect(
      extractedClaims.some(
        (claim) => claim.provenance?.path === "linear/issues/foo--1.md",
      ),
    ).toBe(false)
    expect(
      extractedClaims.some((claim) => claim.provenance?.path === "/users"),
    ).toBe(false)
  })

  it("does not re-emit an existing File or PART_OF triple", () => {
    const fileKey = fileDedupKey(repositoryId, "README.md")
    const { extractedObjects, extractedClaims } = linkLocatedPaths({
      repositoryId,
      targetHash,
      objects: [
        service("./"),
        {
          kind: "File",
          deduplicationKey: fileKey,
          name: "README.md",
          payload: { path: "README.md" },
        },
        unit("README.md"),
      ],
      claims: [
        {
          subjectRef: fileKey,
          subjectKind: "File",
          objectRef: repositoryId,
          objectKind: "Repository",
          predicate: "PART_OF",
          sourceId: "existing",
          sourceType: "git",
          extractionMethod: "deterministic",
          confidence: 0.95,
        },
      ],
    })

    expect(extractedObjects).toEqual([])
    expect(
      extractedClaims.some(
        (claim) =>
          claim.subjectRef === fileKey && claim.objectKind === "Repository",
      ),
    ).toBe(false)
    expect(
      extractedClaims.some(
        (claim) =>
          claim.predicate === "DECLARED_IN" && claim.objectRef === fileKey,
      ),
    ).toBe(true)
  })
})

describe("resolveReferenceClaims", () => {
  const referenceClaim = (
    subjectRef: string,
    objectRef: string,
  ): ExtractedClaim => ({
    subjectRef,
    subjectKind: "Issue",
    objectRef,
    objectKind: "PullRequest",
    predicate: "REFERENCES",
    sourceId: `linearIssue:repo_ctx:x:REFERENCES:${objectRef}:${targetHash}`,
    sourceType: "git",
    extractionMethod: "deterministic",
    confidence: 0.9,
  })
  const issue: ExtractedObject = {
    kind: "Issue",
    deduplicationKey: "iss:linear:ENG-1",
    name: "ENG-1",
  }

  beforeEach(() => {
    mocks.rows = []
    mocks.selectCalls = 0
  })

  it("keeps references whose ends are objects of this run without touching the database", async () => {
    const pull: ExtractedObject = {
      kind: "PullRequest",
      deduplicationKey: "prq:repo_api:42",
      name: "acme/api#42",
    }
    const { claims, summary } = await resolveReferenceClaims({
      orgId: "org_1",
      objects: [issue, pull],
      claims: [referenceClaim(issue.deduplicationKey, pull.deduplicationKey)],
    })
    expect(claims).toHaveLength(1)
    expect(summary).toEqual({ REFERENCES: { kept: 1, dropped: 0 } })
    expect(mocks.selectCalls).toBe(0)
  })

  it("keeps references to existing graph objects and drops unresolved ones", async () => {
    mocks.rows = [{ deduplicationKey: "prq:repo_api:7" }]
    const nonReference: ExtractedClaim = {
      subjectRef: "svc:repo_api:./",
      subjectKind: "Service",
      objectRef: "repo_api",
      objectKind: "Repository",
      predicate: "IMPLEMENTED_IN",
      sourceId: "extractKind:repo_api:./:abc",
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
    }
    const { claims, summary } = await resolveReferenceClaims({
      orgId: "org_1",
      objects: [issue],
      claims: [
        nonReference,
        referenceClaim(issue.deduplicationKey, "prq:repo_api:7"),
        referenceClaim(issue.deduplicationKey, "prq:github:acme/other:9"),
      ],
    })
    expect(claims.map((claim) => claim.objectRef)).toEqual([
      "repo_api",
      "prq:repo_api:7",
    ])
    expect(summary).toEqual({ REFERENCES: { kept: 1, dropped: 1 } })
    expect(mocks.selectCalls).toBe(1)
  })
})

describe("asLocatedPath", () => {
  it("normalizes ./ and rejects routes, parent segments, and connector dumps", () => {
    expect(asLocatedPath("./apps/backend/AGENTS.md")).toBe(
      "apps/backend/AGENTS.md",
    )
    expect(asLocatedPath("apps/backend/AGENTS.md")).toBe(
      "apps/backend/AGENTS.md",
    )
    expect(asLocatedPath("/users")).toBeNull()
    expect(asLocatedPath("foo/../secret")).toBeNull()
    expect(asLocatedPath("linear/issues/x.md")).toBeNull()
  })
})

describe("parsePackageDedupKey", () => {
  it("accepts extractKind package keys and rejects USES_LIBRARY keys", () => {
    expect(parsePackageDedupKey("svc:repo_api:apps/backend")).toEqual({
      kind: "Service",
      repositoryId: "repo_api",
      root: "apps/backend",
      deduplicationKey: "svc:repo_api:apps/backend",
    })
    expect(parsePackageDedupKey("lib:repo_api:apps/backend:lodash")).toBeNull()
  })
})

describe("matchPackageForPath", () => {
  it("picks the longest package root", () => {
    const matched = matchPackageForPath("apps/backend/src/server.ts", [
      {
        kind: "Service",
        repositoryId,
        root: "./",
        deduplicationKey: `svc:${repositoryId}:./`,
      },
      {
        kind: "App",
        repositoryId,
        root: "apps/backend",
        deduplicationKey: `app:${repositoryId}:apps/backend`,
      },
    ])
    expect(matched?.root).toBe("apps/backend")
    expect(matched?.kind).toBe("App")
  })
})
