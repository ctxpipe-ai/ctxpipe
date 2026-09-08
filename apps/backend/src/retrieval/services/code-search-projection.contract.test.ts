import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { expect, it } from "vitest"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../../domain/workspaces/revision.js"
import { codeSearch } from "./codeSearch.js"

it(
  "searches the published revision even when the derived index has moved ahead",
  { timeout: 60_000 },
  async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for search proof")
    const directory = await mkdtemp(
      join(tmpdir(), "ctxpipe-search-projection-"),
    )
    const id = `search_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const org = {
      id: `org_${id}`,
      slug: id,
      name: "Search projection contract",
    }
    const workspaceId = `ws_${id}`
    const repositoryId = `repo_${id}`
    const url = "https://example.test/published-context.git"
    const revision: WorkspaceRevision = {
      workspaceId,
      generation: 1,
      remote: { url, githubConnectionId: null },
      defaultBranch: "main",
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      access: "read",
    }
    const savedEnv = {
      CODESEARCH_URL: process.env.CODESEARCH_URL,
      ZOEKT_WEBSERVER_URL: process.env.ZOEKT_WEBSERVER_URL,
      ZOEKT_INDEX_DIR: process.env.ZOEKT_INDEX_DIR,
      REPO_CACHE_DIR: process.env.REPO_CACHE_DIR,
    }
    Object.assign(process.env, {
      CODESEARCH_URL: "http://projection-codesearch.test",
      ZOEKT_WEBSERVER_URL: "http://projection-zoekt.test",
      ZOEKT_INDEX_DIR: join(directory, "cold"),
      REPO_CACHE_DIR: join(directory, "repos"),
    })
    const { createApp } = await import("../../../../codesearch/src/app/app.js")
    const { unpinRepo } = await import(
      "../../../../codesearch/src/domain/zoekt/pinManager.js"
    )
    const { zoektRepositoryName } = await import(
      "../../../../codesearch/src/domain/zoekt/shardPrefix.js"
    )
    const app = createApp({
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: parseEnv(process.env).AUTH_SECRET,
      PORT: 0,
      NODE_ENV: "test",
    })
    // The real app owns its pool; this fixture-only endpoint closes it after all requests.
    app.get("/__contract/close", async (c) => {
      await c.get("db")?.$client.end()
      return c.text("closed")
    })
    let linkedZoektRepoId = 0
    let zoektRepoId = 0
    let indexedVersion = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    let codesearchRequests = 0
    const server = setupServer(
      http.post(
        "http://projection-codesearch.test/search",
        async ({ request }) => {
          codesearchRequests++
          return app.request(request)
        },
      ),
      http.post("http://projection-zoekt.test/api/search", () =>
        HttpResponse.json({
          Result: {
            Files: [
              {
                RepositoryID: linkedZoektRepoId,
                FileName: "OTHER.md",
                Version: "cccccccccccccccccccccccccccccccccccccccc",
              },
              {
                RepositoryID: zoektRepoId,
                FileName: "AGENTS.md",
                Version: indexedVersion,
                LineMatches: [
                  { LineNumber: 1, Line: "Published instructions" },
                ],
              },
            ],
          },
        }),
      ),
    )
    server.listen({ onUnhandledRequest: "error" })
    initDb(databaseUrl)
    try {
      await getSystemDb()
        .insert(organizations)
        .values({ ...org, createdAt: new Date() })
      await withOrgDbContext(org.id, async (db) => {
        await db.insert(workspaces).values({
          id: workspaceId,
          orgId: org.id,
          slug: id,
          displayName: org.name,
          workspaceRepositoryUrl: url,
          desiredGeneration: 1,
          desiredSha: indexedVersion,
          desiredDefaultBranch: "main",
          activeRevision: revision,
          activeProjectionUrl: url,
          activeProjectionSha: revision.sha,
          indexedSha: revision.sha,
          hydrateStatus: "ready",
          hydratePhases: {
            url,
            sha: revision.sha,
            revision,
            embeddings: true,
            index: { revision, result: { kind: "ready" } },
          },
        })
        await db.insert(repositories).values({
          id: repositoryId,
          orgId: org.id,
          name: "Published context",
          gitUrl: url,
        })
        const [checkout] = await db
          .insert(repositoryCheckouts)
          .values({
            id: `co_${id}`,
            orgId: org.id,
            repositoryId,
            ref: revision.sha,
            checkoutKey: `ws:${workspaceId}:${revision.sha}`,
            commitSha: revision.sha,
          })
          .returning()
        if (!checkout) throw new Error("Missing fixture checkout")
        zoektRepoId = checkout.zoektRepoId
        const linkedRepoId = repositoryId + "_linked"
        await db.insert(repositories).values({
          id: linkedRepoId,
          orgId: org.id,
          name: "Linked context",
          gitUrl: url + "-linked",
        })
        await db.insert(workspaceLinkedRepositories).values({
          id: "wlr_" + id,
          orgId: org.id,
          workspaceId,
          gitUrl: url + "-linked",
          desiredSha: "cccccccccccccccccccccccccccccccccccccccc",
          indexedSha: "cccccccccccccccccccccccccccccccccccccccc",
        })
        const [linkedCheckout] = await db
          .insert(repositoryCheckouts)
          .values({
            id: "co_linked_" + id,
            orgId: org.id,
            repositoryId: linkedRepoId,
            ref: "cccccccccccccccccccccccccccccccccccccccc",
            commitSha: "cccccccccccccccccccccccccccccccccccccccc",
            checkoutKey: `ws:${workspaceId}:cccccccccccccccccccccccccccccccccccccccc`,
          })
          .returning()
        if (!linkedCheckout) throw new Error("Missing linked checkout")
        linkedZoektRepoId = linkedCheckout.zoektRepoId
      })
      await withOrgIdContext(org, async () => {
        expect(
          await codeSearch(org.id, {
            query: "instructions",
            workspaceId,
            repositoryIds: [repositoryId],
          }),
        ).toEqual([])
        indexedVersion = revision.sha
        const matches = await codeSearch(org.id, {
          query: "instructions",
          workspaceId,
          repositoryIds: [repositoryId],
        })
        expect(matches).toHaveLength(1)
        expect(matches[0]?.response).toMatchObject({
          Files: [{ FileName: "AGENTS.md", Version: revision.sha }],
        })
        expect(matches[0]?.response.Files).toHaveLength(1)
        expect(codesearchRequests).toBe(2)
        const allMatches = await codeSearch(org.id, {
          query: "instructions",
          workspaceId,
        })
        expect(allMatches).toHaveLength(2)
        expect(allMatches[0]?.response.Files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              FileName: "OTHER.md",
              Version: "cccccccccccccccccccccccccccccccccccccccc",
            }),
            expect.objectContaining({
              FileName: "AGENTS.md",
              Version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }),
          ]),
        )
      })
    } finally {
      await unpinRepo({
        zoektRepoId,
        zoektName: zoektRepositoryName({
          orgId: org.id,
          repoId: repositoryId,
          checkoutKey: `ws:${workspaceId}:${revision.sha}`,
        }),
      })
      await unpinRepo({
        zoektRepoId: linkedZoektRepoId,
        zoektName: zoektRepositoryName({
          orgId: org.id,
          repoId: repositoryId + "_linked",
          checkoutKey: `ws:${workspaceId}:cccccccccccccccccccccccccccccccccccccccc`,
        }),
      })
      await withOrgDbContext(org.id, async (db) => {
        await db.delete(repositories).where(eq(repositories.id, repositoryId))
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
      })
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, org.id))
      const token = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: { sub: `org:${org.id}`, orgId: org.id, principal: "service" },
      })
      expect(
        (
          await app.request("/__contract/close", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200)
      await closeDb()
      server.close()
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
)
