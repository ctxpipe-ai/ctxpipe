import { describe, expect, it } from "vitest"
import {
  buildPackageNameIndex,
  collectDeterministicScanPaths,
  dirOf,
  resolveRelativePath,
  scanDatabases,
  scanInfrastructure,
  scanLibraries,
  scanStreams,
  scanWorkspaceDependencies,
} from "./deterministicRepoScan.js"

describe("deterministicRepoScan", () => {
  describe("scanWorkspaceDependencies", () => {
    it("detects workspace:* dependencies between monorepo packages", () => {
      const paths = ["apps/web/package.json", "packages/shared/package.json"]
      const contents = {
        "apps/web/package.json": JSON.stringify({
          name: "@repo/web",
          dependencies: { "@repo/shared": "workspace:*" },
        }),
        "packages/shared/package.json": JSON.stringify({
          name: "@repo/shared",
        }),
      }
      const index = buildPackageNameIndex(paths, contents)
      const deps = scanWorkspaceDependencies(paths, contents, index)

      expect(deps).toHaveLength(1)
      expect(deps[0]).toMatchObject({
        consumerPath: "apps/web",
        providerPath: "packages/shared",
        evidence: "apps/web/package.json: @repo/shared@workspace:*",
      })
    })

    it("detects file: workspace references", () => {
      const paths = ["apps/api/package.json"]
      const contents = {
        "apps/api/package.json": JSON.stringify({
          dependencies: { shared: "file:../../packages/shared" },
        }),
      }
      const index = buildPackageNameIndex(paths, contents)
      const deps = scanWorkspaceDependencies(paths, contents, index)

      expect(deps).toHaveLength(1)
      expect(deps[0].providerPath).toBe("packages/shared")
    })

    it("deduplicates identical consumer→provider pairs", () => {
      const paths = ["apps/web/package.json"]
      const contents = {
        "apps/web/package.json": JSON.stringify({
          dependencies: { "@repo/shared": "workspace:*" },
          devDependencies: { "@repo/shared": "workspace:^" },
        }),
      }
      const index = new Map([["@repo/shared", "packages/shared"]])
      const deps = scanWorkspaceDependencies(paths, contents, index)
      expect(deps).toHaveLength(1)
    })
  })

  describe("scanLibraries", () => {
    it("detects architectural libraries from package.json", () => {
      const paths = ["apps/backend/package.json"]
      const contents = {
        "apps/backend/package.json": JSON.stringify({
          dependencies: {
            hono: "^4.0.0",
            zod: "^3.0.0",
            "better-auth": "^1.0.0",
            lodash: "^4.0.0",
          },
        }),
      }
      const libs = scanLibraries(paths, contents)
      const names = libs.map((l) => l.name).sort()
      expect(names).toEqual(["Better Auth", "Hono", "Zod"])
      expect(libs.find((l) => l.name === "Hono")).toMatchObject({
        category: "HTTP",
        path: "apps/backend",
      })
    })
  })

  describe("scanDatabases", () => {
    it("detects Postgres from Prisma schema", () => {
      const paths = ["apps/backend/prisma/schema.prisma"]
      const contents = {
        "apps/backend/prisma/schema.prisma": `
          datasource db {
            provider = "postgresql"
            url      = env("DATABASE_URL")
          }
        `,
      }
      const dbs = scanDatabases(paths, contents)
      expect(dbs).toHaveLength(1)
      expect(dbs[0]).toMatchObject({
        dbType: "Postgres",
        path: "apps/backend/prisma",
      })
    })

    it("detects databases from docker-compose services", () => {
      const paths = ["docker-compose.yml"]
      const contents = {
        "docker-compose.yml": `
          services:
            postgres:
              image: postgres:16
            redis:
              image: redis:7
        `,
      }
      const dbs = scanDatabases(paths, contents)
      const types = dbs.map((d) => d.dbType).sort()
      expect(types).toEqual(["Postgres", "Redis"])
    })

    it("detects databases from package.json drivers", () => {
      const paths = ["package.json"]
      const contents = {
        "package.json": JSON.stringify({
          dependencies: { pg: "^8.0.0", mongoose: "^8.0.0" },
        }),
      }
      const dbs = scanDatabases(paths, contents)
      const types = dbs.map((d) => d.dbType).sort()
      expect(types).toEqual(["Mongo", "Postgres"])
    })
  })

  describe("scanInfrastructure", () => {
    it("detects Docker and Docker Compose from file names", () => {
      const paths = ["apps/api/Dockerfile", "docker-compose.yml"]
      const contents = { "apps/api/Dockerfile": "", "docker-compose.yml": "" }
      const infra = scanInfrastructure(paths, contents)
      const types = infra.map((i) => i.infraType).sort()
      expect(types).toEqual(["Docker", "Docker Compose"])
    })

    it("detects Kubernetes from manifest content", () => {
      const paths = ["k8s/deployment.yaml"]
      const contents = {
        "k8s/deployment.yaml": `
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
        `,
      }
      const infra = scanInfrastructure(paths, contents)
      expect(infra).toHaveLength(1)
      expect(infra[0].infraType).toBe("Kubernetes")
    })
  })

  describe("scanStreams", () => {
    it("detects Kafka from package.json dependencies", () => {
      const paths = ["apps/worker/package.json"]
      const contents = {
        "apps/worker/package.json": JSON.stringify({
          dependencies: { kafkajs: "^2.0.0" },
        }),
      }
      const streams = scanStreams(paths, contents)
      expect(streams).toHaveLength(1)
      expect(streams[0]).toMatchObject({
        streamType: "Kafka",
        path: "apps/worker",
        role: "both",
      })
    })
  })

  describe("path helpers", () => {
    it("resolves relative paths", () => {
      expect(resolveRelativePath("apps/web", "../packages/shared")).toBe(
        "apps/packages/shared",
      )
      expect(dirOf("apps/web/package.json")).toBe("apps/web")
      expect(dirOf("package.json")).toBe("./")
    })

    it("collects scan paths for partial ingestion scope", () => {
      const all = [
        "apps/web/package.json",
        "apps/api/package.json",
        "apps/web/src/index.ts",
      ]
      const collected = collectDeterministicScanPaths(all, ["apps/web"])
      expect(collected).toContain("apps/web/package.json")
      expect(collected).not.toContain("apps/api/package.json")
    })
  })
})
