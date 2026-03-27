import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { ExtractedObject } from "../schemas.js"
import {
  buildDedupKey,
  deriveSkillsFromUnits,
  envelopesCompatible,
  instructionSourceTier,
  isInstructionCandidatePath,
  isRepoRootInstructionPath,
  looksEphemeral,
  resolveInstructionSubmissionRoot,
  sortInstructionCandidates,
} from "./extractInstructionUnits.js"

describe("extractInstructionUnits helpers", () => {
  it("isRepoRootInstructionPath marks root-level and root .cursor/docs trees", () => {
    expect(isRepoRootInstructionPath("AGENTS.md")).toBe(true)
    expect(isRepoRootInstructionPath(".cursor/rules/x.md")).toBe(true)
    expect(isRepoRootInstructionPath(".agents/rules/x.mdc")).toBe(true)
    expect(isRepoRootInstructionPath("docs/README.md")).toBe(true)
    expect(isRepoRootInstructionPath("apps/ui/README.md")).toBe(false)
  })

  it("isInstructionCandidatePath includes .agents rules, .mdc, and skills/SKILL.md", () => {
    expect(isInstructionCandidatePath(".agents/rules/project-memory.mdc")).toBe(
      true,
    )
    expect(isInstructionCandidatePath(".cursor/rules/project-memory.mdc")).toBe(
      true,
    )
    expect(isInstructionCandidatePath(".agents/skills/drizzle-migrations/SKILL.md")).toBe(
      true,
    )
    expect(isInstructionCandidatePath("apps/foo/README.md")).toBe(true)
    expect(isInstructionCandidatePath("apps/foo/SKILL.md")).toBe(false)
  })

  it("instructionSourceTier ranks rules and skills above README", () => {
    expect(instructionSourceTier(".agents/rules/a.mdc")).toBe(1)
    expect(instructionSourceTier(".agents/skills/x/SKILL.md")).toBe(1)
    expect(instructionSourceTier("CONTRIBUTING.md")).toBe(2)
    expect(instructionSourceTier("apps/ui/README.md")).toBe(3)
  })

  it("sortInstructionCandidates orders by tier then path", () => {
    const sorted = sortInstructionCandidates([
      "z/README.md",
      "AGENTS.md",
      "a/README.md",
    ])
    expect(sorted).toEqual(["AGENTS.md", "a/README.md", "z/README.md"])
  })

  it("resolveInstructionSubmissionRoot falls back to ./ for repo-root instructions on a package-only fan-out branch", () => {
    const roots = ["apps/backend"] as const
    expect(resolveInstructionSubmissionRoot("AGENTS.md", [...roots])).toBe("./")
    expect(
      resolveInstructionSubmissionRoot(".cursor/rules/x.md", [...roots]),
    ).toBe("./")
    expect(
      resolveInstructionSubmissionRoot(".agents/rules/x.mdc", [...roots]),
    ).toBe("./")
    expect(resolveInstructionSubmissionRoot("docs/README.md", [...roots])).toBe(
      "./",
    )
    expect(
      resolveInstructionSubmissionRoot("apps/ui/README.md", [...roots]),
    ).toBeNull()
    expect(
      resolveInstructionSubmissionRoot("apps/backend/README.md", [...roots]),
    ).toBe("apps/backend")
  })

  it("resolveInstructionSubmissionRoot leaves multi-root + ./ drop behavior to generic resolver", () => {
    const multi = ["./", "apps/web"]
    expect(resolveInstructionSubmissionRoot("AGENTS.md", multi)).toBeNull()
    expect(resolveInstructionSubmissionRoot("apps/web/foo", multi)).toBe(
      "apps/web",
    )
  })

  it("workspace root svc:…:./ stub predicate: any candidate resolving to ./ (incl. default roots)", () => {
    const rootsDefault = ["./"]
    expect(
      ["AGENTS.md"].some(
        (p) => resolveInstructionSubmissionRoot(p, rootsDefault) === "./",
      ),
    ).toBe(true)

    const rootsPackageOnly = ["apps/backend"]
    expect(
      ["AGENTS.md"].some(
        (p) => resolveInstructionSubmissionRoot(p, rootsPackageOnly) === "./",
      ),
    ).toBe(true)
  })

  it("workspace root svc stub predicate is false when no candidate maps to ./", () => {
    const roots = ["apps/backend"]
    expect(
      ["apps/backend/README.md"].some(
        (p) => resolveInstructionSubmissionRoot(p, roots) === "./",
      ),
    ).toBe(false)
  })

  it("looksEphemeral detects temporary phrasing", () => {
    expect(looksEphemeral("This is temporary until we migrate")).toBe(true)
    expect(looksEphemeral("Always run tests before push")).toBe(false)
  })

  function excerptContentHash(excerpt: string): string {
    return createHash("sha256")
      .update(excerpt, "utf8")
      .digest("hex")
      .slice(0, 32)
  }

  it("buildDedupKey uses content_hash + path + root + repositoryId (not paraphrase-sensitive)", () => {
    const excerpt = "Always run pnpm test before opening a PR."
    const h = excerptContentHash(excerpt)
    const a = buildDedupKey({
      repositoryId: "repo1",
      root: "./",
      path: "AGENTS.md",
      contentHash: h,
    })
    const b = buildDedupKey({
      repositoryId: "repo1",
      root: "./",
      path: "AGENTS.md",
      contentHash: h,
    })
    expect(a).toBe(b)
    expect(
      buildDedupKey({
        repositoryId: "repo1",
        root: "./",
        path: "OTHER.md",
        contentHash: h,
      }),
    ).not.toBe(a)
  })

  it("deriveSkillsFromUnits creates Skill when ≥2 compatible units", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "AGENTS.md",
          line_start: 1,
          line_end: 2,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "CONTRIBUTING.md",
          line_start: 10,
          line_end: 12,
          modality: "required",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(1)
    expect(objects[0]?.kind).toBe("Skill")
    expect(claims.length).toBe(2)
    expect(claims.every((c) => c.predicate === "MEMBER_OF_PRIMARY")).toBe(true)
  })

  it("deriveSkillsFromUnits skips single unit", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "solo",
          applicability: { tags: [] },
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  it("deriveSkillsFromUnits skips cluster when all members share identical evidence span", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "AGENTS.md",
          line_start: 5,
          line_end: 6,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "AGENTS.md",
          line_start: 5,
          line_end: 6,
          modality: "required",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  it("deriveSkillsFromUnits skips when a member is below confidence floor", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "required",
          confidence: 0.55,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  it("deriveSkillsFromUnits skips mixed negative and positive modality across members", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "forbidden",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "run tests",
          applicability: { tags: ["ci"] },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "optional",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(0)
    expect(claims).toHaveLength(0)
  })

  it("deriveSkillsFromUnits uses source_tier when confidence omitted (tier 3 ≥ floor)", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"] },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "recommended",
          source_tier: 3,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"] },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "recommended",
          source_tier: 3,
        },
      },
    ]
    const { objects } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(1)
  })

  it("envelopesCompatible: tags unchanged; scope/environment omit is wildcard; both set must match", () => {
    const base = { tags: ["ci", "node"] as const }
    expect(
      envelopesCompatible(
        { ...base, scope: "repository", environment: "ci" },
        { ...base, scope: "repository", environment: "ci" },
      ),
    ).toBe(true)
    expect(
      envelopesCompatible(
        { ...base, scope: "repository" },
        { ...base, scope: "package" },
      ),
    ).toBe(false)
    expect(
      envelopesCompatible({ ...base, scope: "repository" }, { ...base }),
    ).toBe(true)
    expect(
      envelopesCompatible(
        { ...base, environment: "production" },
        { ...base, environment: "ci" },
      ),
    ).toBe(false)
    expect(
      envelopesCompatible(
        { ...base, environment: "ci" },
        { ...base, environment: undefined },
      ),
    ).toBe(true)
  })

  it("deriveSkillsFromUnits splits into two Skills when scope conflicts in same intent+tags bucket", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:r1",
        name: "R1",
        summary: "s1",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"], scope: "repository" },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:r2",
        name: "R2",
        summary: "s2",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"], scope: "repository" },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:p1",
        name: "P1",
        summary: "s3",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"], scope: "package" },
          path: "c.md",
          line_start: 3,
          line_end: 3,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:p2",
        name: "P2",
        summary: "s4",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"], scope: "package" },
          path: "d.md",
          line_start: 4,
          line_end: 4,
          modality: "required",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(2)
    expect(claims).toHaveLength(4)
    expect(new Set(objects.map((o) => o.deduplicationKey)).size).toBe(2)
  })

  it("deriveSkillsFromUnits merges scope omitted with explicit scope (wildcard)", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"] },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "required",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "lint",
          applicability: { tags: ["ci"], scope: "repository" },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "required",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(1)
    expect(claims).toHaveLength(2)
  })

  it("deriveSkillsFromUnits allows only-negative modalities in one cluster (avoid + forbidden)", () => {
    const units: ExtractedObject[] = [
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:a",
        name: "A",
        summary: "s1",
        payload: {
          intent: "no console",
          applicability: { tags: ["js"] },
          path: "a.md",
          line_start: 1,
          line_end: 1,
          modality: "avoid",
          confidence: 0.72,
        },
      },
      {
        kind: "InstructionUnit",
        deduplicationKey: "inu:r:./:b",
        name: "B",
        summary: "s2",
        payload: {
          intent: "no console",
          applicability: { tags: ["js"] },
          path: "b.md",
          line_start: 2,
          line_end: 2,
          modality: "forbidden",
          confidence: 0.72,
        },
      },
    ]
    const { objects, claims } = deriveSkillsFromUnits({
      repositoryId: "repo_x",
      targetHash: "abc",
      units,
    })
    expect(objects).toHaveLength(1)
    expect(claims.length).toBe(2)
  })
})
