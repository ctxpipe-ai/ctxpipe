import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CodeIngestionState } from "../schemas.js"

const createAgentMock = vi.hoisted(() => vi.fn())
const deterministicDetectDatabasesMock = vi.hoisted(() => vi.fn())
const requireCurrentOrgIdMock = vi.hoisted(() => vi.fn())
const getModelMock = vi.hoisted(() => vi.fn())
const loggerInfoMock = vi.hoisted(() => vi.fn())
const loggerWarnMock = vi.hoisted(() => vi.fn())

vi.mock("../../createAgent.js", () => ({
  createAgent: createAgentMock,
}))

vi.mock("./identifyDatabasesDeterministic.js", () => ({
  deterministicDetectDatabases: deterministicDetectDatabasesMock,
  normalizeDbType: (dbType: string) => dbType,
}))

vi.mock("../../../auth/context.js", () => ({
  requireCurrentOrgId: requireCurrentOrgIdMock,
}))

vi.mock("../../../retrieval/services/modelProvider.js", () => ({
  getModel: getModelMock,
}))

vi.mock("../../../observability/logger.js", () => ({
  getLogger: () => ({
    info: loggerInfoMock,
    warn: loggerWarnMock,
  }),
}))

import { identifyDatabases } from "./identifyDatabases.js"

function baseState(): CodeIngestionState {
  return {
    repositoryId: "repo_test",
    orgId: "org_test",
    targetHash: "abc123",
    roots: ["apps/api"],
    extractedObjects: [],
    extractedClaims: [],
    objectIds: [],
    touchedObjectIds: [],
    claimsForProjection: [],
  }
}

async function submitDatabasesFromAgent(
  tools: unknown,
  databases: Array<{ dbType: string; path: string; evidence?: string }>,
): Promise<void> {
  const submitTool = (tools as Array<{ name: string; invoke: (input: unknown) => Promise<unknown> }>).find(
    (tool) => tool.name === "submit_databases",
  )
  if (!submitTool) {
    throw new Error("submit_databases tool missing in test")
  }
  await submitTool.invoke({ databases })
}

describe("identifyDatabases", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getModelMock.mockReturnValue({ model: "test-model" })
  })

  it("skips LLM when root is fully resolved deterministically", async () => {
    deterministicDetectDatabasesMock.mockResolvedValue({
      accepted: [
        {
          root: "apps/api",
          dbType: "Postgres",
          normalizedDbType: "Postgres",
          confidence: 0.85,
          evidence: [],
          signalKinds: ["provider-config", "client-initialization"],
          matchedFiles: ["apps/api/prisma/schema.prisma"],
          scoreBreakdown: {
            "provider-config": 0.6,
            "client-initialization": 0.25,
          },
        },
      ],
      ambiguous: [],
      unresolvedRoots: [],
      scanErrors: [],
    })

    const result = await identifyDatabases(baseState())

    expect(createAgentMock).not.toHaveBeenCalled()
    expect(result.extractedObjects).toEqual([
      expect.objectContaining({
        kind: "Database",
        deduplicationKey: "db:repo_test:apps/api:Postgres",
      }),
    ])
    expect(result.extractedClaims).toEqual([
      expect.objectContaining({
        extractionMethod: "deterministic",
        confidence: 0.85,
      }),
    ])
  })

  it("merges deterministic and LLM outputs without duplicate DB keys", async () => {
    deterministicDetectDatabasesMock.mockResolvedValue({
      accepted: [
        {
          root: "apps/worker",
          dbType: "Postgres",
          normalizedDbType: "Postgres",
          confidence: 0.85,
          evidence: [],
          signalKinds: ["provider-config", "client-initialization"],
          matchedFiles: ["apps/worker/prisma/schema.prisma"],
          scoreBreakdown: {
            "provider-config": 0.6,
            "client-initialization": 0.25,
          },
        },
      ],
      ambiguous: [
        {
          root: "apps/worker",
          dbType: "Redis",
          normalizedDbType: "Redis",
          confidence: 0.6,
          evidence: [],
          signalKinds: ["connection-string"],
          matchedFiles: ["apps/worker/.env"],
          scoreBreakdown: { "connection-string": 0.6 },
        },
      ],
      unresolvedRoots: [],
      scanErrors: [],
    })

    createAgentMock.mockImplementation(({ tools }: { tools: unknown }) => ({
      invoke: async () => {
        await submitDatabasesFromAgent(tools, [
          { dbType: "Postgres", path: "apps/worker/prisma/schema.prisma" },
          { dbType: "Mongo", path: "apps/worker/src/db.ts" },
        ])
      },
    }))

    const result = await identifyDatabases({
      ...baseState(),
      roots: ["apps/worker"],
    })

    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const objects = result.extractedObjects ?? []
    expect(objects).toHaveLength(2)
    expect(
      objects.filter(
        (obj) => obj.deduplicationKey === "db:repo_test:apps/worker:Postgres",
      ),
    ).toHaveLength(1)
    const claims = result.extractedClaims ?? []
    expect(
      claims.map((claim) => `${claim.objectRef}:${claim.extractionMethod}`).sort(),
    ).toEqual([
      "db:repo_test:apps/worker:Mongo:llm",
      "db:repo_test:apps/worker:Postgres:deterministic",
    ])
  })

  it("uses resolveSubmissionRoot semantics for mixed roots", async () => {
    deterministicDetectDatabasesMock.mockResolvedValue({
      accepted: [],
      ambiguous: [],
      unresolvedRoots: ["./", "apps/worker"],
      scanErrors: [],
    })

    createAgentMock.mockImplementation(({ tools }: { tools: unknown }) => ({
      invoke: async () => {
        await submitDatabasesFromAgent(tools, [
          { dbType: "MySQL", path: "vendor/unknown" },
          { dbType: "Redis", path: "apps/worker/src/queue.ts" },
        ])
      },
    }))

    const result = await identifyDatabases({
      ...baseState(),
      roots: ["./", "apps/worker"],
    })

    const keys = (result.extractedObjects ?? []).map((obj) => obj.deduplicationKey)
    expect(keys).toEqual(["db:repo_test:apps/worker:Redis"])
  })
})
