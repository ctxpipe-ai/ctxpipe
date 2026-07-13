import { beforeEach, describe, expect, it, vi } from "vitest"

const listFilesRecursiveMock = vi.hoisted(() => vi.fn())
const fetchFilesMock = vi.hoisted(() => vi.fn())

vi.mock("../../../domain/codeIngestion/codesearchClient.js", () => ({
  listFilesRecursive: listFilesRecursiveMock,
  fetchFiles: fetchFilesMock,
}))

import {
  deterministicDetectDatabases,
  normalizeDbType,
} from "./identifyDatabasesDeterministic.js"

describe("identifyDatabasesDeterministic", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("normalizes db aliases to canonical names", () => {
    expect(normalizeDbType("postgresql")).toBe("Postgres")
    expect(normalizeDbType("pg")).toBe("Postgres")
    expect(normalizeDbType("redis")).toBe("Redis")
    expect(normalizeDbType("cockroach")).toBe("CockroachDB")
  })

  it("keeps provider-only signals in ambiguous range", async () => {
    listFilesRecursiveMock.mockResolvedValue(["apps/api/prisma/schema.prisma"])
    fetchFilesMock.mockResolvedValue({
      "apps/api/prisma/schema.prisma":
        'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
    })

    const result = await deterministicDetectDatabases({
      repositoryId: "repo_test",
      orgId: "org_test",
      roots: ["apps/api"],
      scanPaths: [],
    })

    expect(result.accepted).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(1)
    expect(result.ambiguous[0]).toMatchObject({
      root: "apps/api",
      dbType: "Postgres",
      confidence: 0.6,
      signalKinds: ["provider-config"],
    })
    expect(result.unresolvedRoots).toHaveLength(0)
  })

  it("accepts candidates when independent signals corroborate", async () => {
    listFilesRecursiveMock.mockResolvedValue([
      "apps/api/prisma/schema.prisma",
      "apps/api/package.json",
      "apps/api/src/db.ts",
    ])
    fetchFilesMock.mockResolvedValue({
      "apps/api/prisma/schema.prisma":
        'datasource db { provider = "postgresql" url = env("DATABASE_URL") }',
      "apps/api/package.json": JSON.stringify({
        dependencies: { pg: "^8.0.0" },
      }),
      "apps/api/src/db.ts": 'import { Pool } from "pg"\nconst pool = new Pool()',
    })

    const result = await deterministicDetectDatabases({
      repositoryId: "repo_test",
      orgId: "org_test",
      roots: ["apps/api"],
      scanPaths: [],
    })

    expect(result.accepted).toHaveLength(1)
    const accepted = result.accepted[0]
    expect(accepted).toBeDefined()
    if (!accepted) throw new Error("expected accepted database candidate")
    expect(accepted).toMatchObject({
      root: "apps/api",
      dbType: "Postgres",
      confidence: 1,
    })
    expect(accepted.signalKinds.sort()).toEqual(
      ["provider-config", "driver-dependency", "client-initialization"].sort(),
    )
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unresolvedRoots).toHaveLength(0)
  })

  it("respects partial scan filtering by root paths", async () => {
    listFilesRecursiveMock.mockImplementation(
      async (_repositoryId: string, _orgId: string, root: string) => {
        if (root === "apps/api") {
          return ["apps/api/package.json", "apps/api/src/db.ts"]
        }
        if (root === "apps/worker") {
          return ["apps/worker/.env"]
        }
        return []
      },
    )
    fetchFilesMock.mockResolvedValue({
      "apps/api/src/db.ts": 'import { Pool } from "pg"\nconst pool = new Pool()',
      "apps/api/package.json": JSON.stringify({
        dependencies: { pg: "^8.0.0" },
      }),
      "apps/worker/.env": "DATABASE_URL=postgres://worker",
    })

    const result = await deterministicDetectDatabases({
      repositoryId: "repo_test",
      orgId: "org_test",
      roots: ["apps/api", "apps/worker"],
      scanPaths: ["apps/api/src/db.ts"],
    })

    expect(result.accepted).toHaveLength(0)
    expect(result.ambiguous).toHaveLength(0)
    expect(result.unresolvedRoots.sort()).toEqual(["apps/api", "apps/worker"])
  })
})
