/**
 * Golden spec of the deterministic graph (ADR-033). Builds a small context
 * repository and source repository with the *real* connector renderers, runs
 * every deterministic extractor plus the link pass, and snapshots the triple
 * set. Also asserts the commutation laws the ontology promises.
 */
import { matchesGlob } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { isConventionalEvidenceSourceId } from "../../domain/codeIngestion/evidenceSourceId.js"
import { renderGithubPullRequest } from "../../services/github/pull-request-mirror/converter.js"
import {
  renderLinearEntity,
  renderLinearIssue,
} from "../../services/linear/converter.js"
import { toSlackThreadMarkdownFile } from "../../services/slack/converter.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "./schemas.js"

const CONTEXT_REPO = "repo_ctx"
const SOURCE_REPO = "repo_api"
const TARGET_HASH = "golden"

const repos = vi.hoisted(() => ({
  files: new Map<string, Map<string, string>>(),
}))

vi.mock("../../domain/codeIngestion/codesearchClient.js", () => ({
  globFiles: async (
    repositoryId: string,
    _org: string,
    opts: { pattern: string },
  ) => ({
    entries: [...(repos.files.get(repositoryId)?.keys() ?? [])]
      .filter((path) => matchesGlob(path, opts.pattern))
      .map((path) => ({ type: "file", path })),
  }),
  fetchFiles: async (repositoryId: string, _org: string, paths: string[]) =>
    Object.fromEntries(
      paths.map((path) => [
        path,
        repos.files.get(repositoryId)?.get(path) ?? "",
      ]),
    ),
}))
vi.mock("./nodes/repositoryResolution.js", () => ({
  resolveSourceRepositoryId: async ({ repository }: { repository: string }) =>
    repository === "acme/api" ? SOURCE_REPO : undefined,
}))
vi.mock("../../db/client.js", () => ({
  getOrgDb: () => ({
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }),
}))
vi.mock("./nodes/linkLocatedPaths.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./nodes/linkLocatedPaths.js")>()
  return {
    ...original,
    listLinearTeamKeys: async () => ["ENG"],
    listPackageRootsForRepository: async () => [
      {
        kind: "Service",
        repositoryId: SOURCE_REPO,
        root: "src",
        deduplicationKey: `svc:${SOURCE_REPO}:src`,
      },
    ],
  }
})

import { CONNECTOR_EXTRACTORS } from "./nodes/connectorExtractors.js"
import { extractCodeowners } from "./nodes/extractCodeowners.js"
import { extractDecisions } from "./nodes/extractDecisions.js"
import {
  linkLocatedPaths,
  resolveReferenceClaims,
} from "./nodes/linkLocatedPaths.js"

function state(
  repositoryId: string,
  extractedObjects: ExtractedObject[] = [],
): CodeIngestionState {
  return {
    repositoryId,
    orgId: "org_1",
    targetHash: TARGET_HASH,
    githubConnectionId: "con_gh",
    roots: ["./"],
    extractedObjects,
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }
}

function buildContextRepo(): Map<string, string> {
  const files = new Map<string, string>()
  const pull = renderGithubPullRequest({
    id: 1042,
    number: 42,
    repository: "acme/api",
    url: "https://github.com/acme/api/pull/42",
    title: "ENG-123 Split user create",
    body: "Move logic out of the handler.",
    state: "closed",
    merged: true,
    draft: false,
    author: { login: "alice", type: "human" },
    base: { ref: "main", sha: "a" },
    head: { ref: "alice/eng-123-split", sha: "b" },
    reviewDecision: "APPROVED",
    labels: [],
    requestedReviewers: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-02T00:00:00.000Z",
    mergedAt: "2026-03-02T11:00:00.000Z",
    files: [
      { path: "src/http/createUser.ts", status: "modified" },
      { path: "src/domain/user.ts", status: "added" },
      { path: "src/legacy.ts", status: "removed" },
    ],
    reviews: [],
    comments: [],
    requiredChecks: [],
  })
  files.set(pull.path, pull.content)

  const issue = renderLinearIssue({
    id: "iss-1",
    identifier: "ENG-123",
    title: "Split user create",
    description: "Handlers are fat.",
    url: "https://linear.app/acme/issue/ENG-123/split-user-create",
    priorityLabel: "High",
    state: "Done",
    teamId: "t1",
    teamKey: "ENG",
    teamName: "Backend",
    projectId: "p1",
    projectName: "Auth cleanup",
    labels: [{ id: "l1", name: "backend" }],
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    updatedAt: new Date("2026-03-02T00:00:00.000Z"),
    comments: [],
    attachments: [
      {
        id: "a1",
        title: "acme/api#42",
        url: "https://github.com/acme/api/pull/42",
        sourceType: "github",
        metadata: { state: "merged" },
      },
    ],
  })
  files.set(issue.path, issue.content)

  const team = renderLinearEntity({
    directory: "teams",
    type: "team",
    id: "t1",
    title: "Backend",
    url: "https://linear.app/acme/team/ENG",
    body: "Owns the API.",
    metadata: { key: "ENG", parentId: null },
  })
  files.set(team.path, team.content)

  const thread = toSlackThreadMarkdownFile({
    channelId: "C01",
    channelName: "eng-backend",
    isPrivate: false,
    threadTs: "1709372400.123456",
    permalink: "https://acme.slack.com/archives/C01/p1709372400123456",
    capturedAt: "2026-03-02T12:00:00.000Z",
    messages: [
      {
        ts: "1709372400.123456",
        userDisplay: "Alice",
        text: "Merging https://github.com/acme/api/pull/42 for ENG-123.",
      },
    ],
  })
  files.set(thread.path, thread.content)
  return files
}

function buildSourceRepo(): Map<string, string> {
  const files = new Map<string, string>()
  files.set(
    "docs/adr/0007-domain-logic-in-services.md",
    "---\nstatus: accepted\ndate: 2026-01-10\n---\n\n# Domain logic lives in services\n\n## Context\n\nHandlers grew fat; see `src/http/createUser.ts`.\n\n## Decision\n\nPut domain logic in services. Supersedes ADR-3.\n",
  )
  files.set(
    "docs/adr/0003-old-handler-layering.md",
    "# Old handler layering\n\nStatus: Superseded\n\nWe kept logic in handlers.\n",
  )
  files.set(
    ".github/CODEOWNERS",
    "*  @acme/platform\n/src/  @acme/backend @alice\n",
  )
  files.set("package.json", '{"name":"api"}')
  return files
}

const sourcePackages: ExtractedObject[] = [
  { kind: "Service", deduplicationKey: `svc:${SOURCE_REPO}:./`, name: "root" },
  { kind: "Service", deduplicationKey: `svc:${SOURCE_REPO}:src`, name: "src" },
]

function tripleLines(claims: ExtractedClaim[]): string[] {
  return claims
    .map(
      (claim) =>
        `${claim.subjectRef} ${claim.predicate} ${claim.objectRef}${claim.validFrom ? ` @${claim.validFrom}` : ""}`,
    )
    .sort()
}

async function extractAll() {
  const contextState = state(CONTEXT_REPO)
  const sourceState = state(SOURCE_REPO, sourcePackages)
  const parts = await Promise.all([
    ...CONNECTOR_EXTRACTORS.map((extractor) => extractor.extract(contextState)),
    extractDecisions(sourceState),
    extractCodeowners(sourceState),
  ])
  const objects: ExtractedObject[] = [...sourcePackages]
  const claims: ExtractedClaim[] = []
  for (const part of parts) {
    objects.push(...(part.extractedObjects ?? []))
    claims.push(...(part.extractedClaims ?? []))
  }
  const located = linkLocatedPaths({
    repositoryId: SOURCE_REPO,
    targetHash: TARGET_HASH,
    objects,
    claims,
  })
  objects.push(...located.extractedObjects)
  claims.push(...located.extractedClaims)
  const resolved = await resolveReferenceClaims({
    orgId: "org_1",
    objects,
    claims,
  })
  return { objects, claims: resolved.claims, summary: resolved.summary }
}

beforeEach(() => {
  repos.files.set(CONTEXT_REPO, buildContextRepo())
  repos.files.set(SOURCE_REPO, buildSourceRepo())
})

describe("graph golden spec", () => {
  it("produces the expected triple set from real connector output", async () => {
    const { objects, claims, summary } = await extractAll()
    expect(
      objects
        .map((object) => `${object.kind} ${object.deduplicationKey}`)
        .sort(),
    ).toMatchSnapshot("objects")
    expect(tripleLines(claims)).toMatchSnapshot("triples")
    // every cross-tool reference in the fixture resolves to a node of this run
    expect(summary).toEqual({
      REFERENCES: { kept: 4, dropped: 0 },
      OWNS: { kept: 3, dropped: 0 },
      INFLUENCES: { kept: 2, dropped: 0 },
      SUPERSEDES: { kept: 1, dropped: 0 },
      MENTIONS: { kept: 1, dropped: 0 },
    })
  })

  it("joins the issue, the pull request, the thread, the file, the service, the team and the decision", async () => {
    const { claims } = await extractAll()
    const lines = tripleLines(claims)
    expect(lines).toContain(
      `iss:linear:ENG-123 REFERENCES prq:${SOURCE_REPO}:42`,
    )
    expect(lines).toContain(
      `prq:${SOURCE_REPO}:42 REFERENCES iss:linear:ENG-123`,
    )
    expect(lines).toContain(
      `thr:slack:C01:1709372400.123456 REFERENCES prq:${SOURCE_REPO}:42`,
    )
    expect(lines).toContain(
      "thr:slack:C01:1709372400.123456 REFERENCES iss:linear:ENG-123",
    )
    expect(lines).toContain("team:linear:ENG OWNS iss:linear:ENG-123")
    expect(lines).toContain(
      `team:github:acme/backend OWNS svc:${SOURCE_REPO}:src`,
    )
    expect(lines).toContain(
      `prq:${SOURCE_REPO}:42 MODIFIED fil:${SOURCE_REPO}:src/http/createUser.ts @2026-03-02`,
    )
    expect(lines).toContain(
      `fil:${SOURCE_REPO}:src/http/createUser.ts PART_OF svc:${SOURCE_REPO}:src`,
    )
    expect(lines).toContain(
      `dec:${SOURCE_REPO}:docs/adr/0007-domain-logic-in-services.md MENTIONS fil:${SOURCE_REPO}:src/http/createUser.ts`,
    )
    expect(lines).toContain(
      `dec:${SOURCE_REPO}:docs/adr/0007-domain-logic-in-services.md INFLUENCES svc:${SOURCE_REPO}:./`,
    )
    expect(lines.some((line) => line.includes(" ABOUT "))).toBe(false)
  })

  it("obeys the commutation laws and the evidence-id convention", async () => {
    const { claims } = await extractAll()
    const has = (subject: string, predicate: string, object: string) =>
      claims.some(
        (claim) =>
          claim.subjectRef === subject &&
          claim.predicate === predicate &&
          claim.objectRef === object,
      )
    // File → Service → Repository must agree with File → Repository
    for (const claim of claims.filter(
      (c) => c.predicate === "PART_OF" && c.objectKind === "Service",
    )) {
      expect(has(claim.subjectRef, "PART_OF", SOURCE_REPO)).toBe(true)
    }
    // a pull request's changed files live in the repository it targets
    const targets = claims.filter((c) => c.predicate === "TARGETS")
    expect(targets).toHaveLength(1)
    for (const change of claims.filter((c) =>
      ["ADDED", "MODIFIED", "RENAMED"].includes(c.predicate),
    )) {
      expect(
        has(change.objectRef, "PART_OF", targets[0]?.objectRef ?? ""),
      ).toBe(true)
    }
    // removed paths are never asserted as contained
    expect(
      has(`fil:${SOURCE_REPO}:src/legacy.ts`, "PART_OF", SOURCE_REPO),
    ).toBe(false)
    // every evidence id follows the convention for its own repository
    for (const claim of claims) {
      const owner = claim.sourceId.split(":")[1] ?? ""
      expect(
        isConventionalEvidenceSourceId(claim.sourceId, owner, TARGET_HASH),
      ).toBe(true)
    }
  })
})
