import { readdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { encodeScipIndex } from "../../../../codesearch/src/domain/graph/scipProto.js"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { repositoryIngestionRequests } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  getWorkspaceSearchProjection,
  persistLinkedIndexedSha,
  persistWorkspaceIndexResult,
} from "../../models/workspaces.js"
import { enqueueWorkspaceIndexesAfterPublish } from "../../openworkflow/enqueue-workspace-index.js"
import { repositoryIndex } from "../../openworkflow/workflows/repository-index.js"
import { workspaceIndex } from "../../openworkflow/workflows/workspace-index.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import {
  type NativeIndexFixture,
  withNativeIndexFixture,
} from "../../test/native-index-fixture.js"
import {
  insertLinkedRepositoryRows,
  setLinkedRepositoryRef,
} from "../../test/workspace-links-fixture.js"
import { releaseRunCheckout } from "../codesearchCheckoutGc.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import type { LinkedRevision, WorkspaceRevision } from "./revision.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"

async function prepareUnpublishedIndex(f: NativeIndexFixture) {
  const { remote, git, org, repositoryId, runner } = f
  await writeFile(
    join(remote, "AGENTS.md"),
    "# Next revision\nUse cobaltmeadow instructions.\n",
  )
  await writeFile(
    join(remote, "sample.js"),
    "function unpublishedHelper() { return 99; }\n",
  )
  git("add", ".")
  git(
    "-c",
    "user.name=Contract",
    "-c",
    "user.email=contract@example.test",
    "commit",
    "-m",
    "Unpublished index",
  )
  const nextSha = git("rev-parse", "HEAD")
  // An ingestion run indexes its own `rev:<sha>`; the repository row does
  // not publish it, so Workspace reads keep the published checkout.
  const unpublishedIndex = await runner.runWorkflow(repositoryIndex.spec, {
    repositoryId,
    orgId: org.id,
    targetHash: nextSha,
    ingestionV2: true,
  })
  expect(await unpublishedIndex.result({ timeoutMs: 30_000 })).toMatchObject({
    searchIndexOk: true,
    targetHash: nextSha,
  })
  return nextSha
}

async function installPublishedScipFixture(f: NativeIndexFixture) {
  const { directory, org, repositoryId, sha } = f
  const symbol =
    "scip-typescript npm fixture 1.0.0 sample.js/publishedHelper()."
  await writeFile(
    join(
      directory,
      "repos",
      org.id,
      repositoryId,
      "checkouts",
      `rev:${sha}.scip`,
    ),
    encodeScipIndex({
      documents: [
        {
          relativePath: "sample.js",
          symbols: [{ symbol, displayName: "publishedHelper", kind: 17 }],
          occurrences: [{ symbol, symbolRoles: 1, range: [0, 9, 24] }],
        },
      ],
    }),
  )
}

/** The request of the one ingestion that a Workspace index queued. */
async function queuedIngestionRequest(f: NativeIndexFixture) {
  const requests = await withOrgDbContext(f.org.id, (db) =>
    db
      .select({ requestId: repositoryIngestionRequests.requestId })
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.repositoryId, f.repositoryId)),
  )
  expect(requests).toHaveLength(1)
  return requests[0]?.requestId
}

/** The `workspace-index` jobs that the app client queued for the org. */
async function queuedWorkspaceIndexes(f: NativeIndexFixture) {
  const queued = await getSystemDb().execute<{
    input: {
      orgId: string
      revision: WorkspaceRevision
      linked?: LinkedRevision
    }
  }>(sql`
    select input from openworkflow.workflow_runs
    where workflow_name = 'workspace-index'
      and input->>'orgId' = ${f.org.id}
      and namespace_id <> ${f.namespace}
  `)
  return queued.rows.map((row) => row.input)
}

/**
 * The Workspace stops to read its repository: its index is no longer
 * published. Tools that a chat captured before keep their snapshot.
 */
async function unlinkWorkspaceRepository(f: NativeIndexFixture) {
  await withOrgDbContext(f.org.id, (db) =>
    db
      .update(workspaces)
      .set({ hydratePhases: null })
      .where(eq(workspaces.id, f.workspaceId)),
  )
}

/** A chat tool from a new snapshot of the Workspace. */
async function freshChatTool(f: NativeIndexFixture, name: string) {
  const snapshot = await withOrgIdContext(f.org, () =>
    getWorkspaceProjectionSnapshot(f.workspaceId),
  )
  const tools = await workspaceChatTools({
    orgId: f.org.id,
    orgSlug: f.org.slug,
    workspaceId: f.workspaceId,
    snapshot,
  })
  return tools.find((tool) => tool.name === name)
}

it(
  "rejects a contradictory queued index revision",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { runner, repositoryId, org, sha, revision } = f
      await expect(
        runner.runWorkflow(workspaceIndex.spec, {
          orgId: org.id,
          revision,
          linked: {
            owner: { ...revision, generation: 2 },
            linkId: "wlr_invalid",
            repositoryId,
            remote: revision.remote,
            ref: "trunk",
            sha,
          },
        }),
      ).rejects.toThrow("Index input must describe one captured owner revision")
    }, false),
)

it(
  "returns no revision for a missing workspace",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org } = f
      await withOrgIdContext(org, async () => {
        await expect(
          resolveWorkspaceReadRevision({
            orgId: org.id,
            workspaceId: generateObjectId("ws"),
            env: parseEnv(process.env),
            refresh: true,
          }),
        ).resolves.toBeNull()
      })
    }, false),
)

it(
  "publishes a native searchable index with the captured commit identity",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const {
        runner,
        indexInput,
        org,
        workspaceId,
        revision,
        repositoryId,
        sha,
      } = f
      await f.publish()
      const handle = await runner.runWorkflow(workspaceIndex.spec, indexInput)
      expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
        published: true,
        role: "workspace",
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision,
          stores: { index: { kind: "ready" } },
        })
        expect(await getWorkspaceSearchProjection(workspaceId)).toMatchObject({
          repositories: [{ id: repositoryId, sha }],
        })
        await expect
          .poll(
            async () => {
              const result = await codeSearch(org.id, {
                workspaceId,
                query: "amberquartz",
              })
              return result[0]?.response.Files
            },
            { timeout: 10_000 },
          )
          .toMatchObject([{ FileName: "AGENTS.md", Version: sha }])
        const chatTools = await workspaceChatTools({
          orgId: org.id,
          orgSlug: org.slug,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        const chatSearch = chatTools.find((tool) => tool.name === "search")
        const matches = String(
          await chatSearch?.execute({
            repositoryId,
            query: "amberquartz",
            detail: "full",
          }),
        )
        expect(matches).toContain("AGENTS.md")
        expect(matches).toContain(sha)
      })
    }, false),
)

it(
  "chat search retains the captured revision across a later branch metadata change",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, repositoryId, sha, revision, remoteUrl } = f
      await withOrgIdContext(org, async () => {
        const chatTools = await workspaceChatTools({
          orgId: org.id,
          orgSlug: org.slug,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        const chatSearch = chatTools.find((tool) => tool.name === "search")
        const matches = String(
          await chatSearch?.execute({
            repositoryId,
            query: "amberquartz",
            detail: "full",
          }),
        )
        expect(matches).toContain("AGENTS.md")
        expect(matches).toContain(sha)
        const movedRevision = { ...revision, defaultBranch: "renamed" }
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({
              activeRevision: movedRevision,
              desiredDefaultBranch: "renamed",
              hydratePhases: {
                url: remoteUrl,
                sha,
                embeddings: false,
                index: { revision: movedRevision, result: { kind: "ready" } },
              },
            })
            .where(eq(workspaces.id, workspaceId)),
        )
        const staleMatches = String(
          await chatSearch?.execute({
            repositoryId,
            query: "amberquartz",
            detail: "full",
          }),
        )
        expect(staleMatches).toContain("AGENTS.md")
      })
    }, true),
)

it(
  "an unpublished index cannot replace the published searchable checkout",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, sha } = f
      await prepareUnpublishedIndex(f)
      await withOrgIdContext(org, async () => {
        const publishedMatches = await codeSearch(org.id, {
          workspaceId,
          query: "amberquartz",
        })
        expect(publishedMatches[0]?.response.Files).toMatchObject([
          { FileName: "AGENTS.md", Version: sha },
        ])
        expect(
          await codeSearch(org.id, { workspaceId, query: "cobaltmeadow" }),
        ).toEqual([])
      })
    }, true),
)

it(
  "an ended run deletes its own checkout on codesearch and keeps the published one",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, repositoryId, sha, directory, workspaceId } = f
      const nextSha = await prepareUnpublishedIndex(f)
      const checkouts = join(
        directory,
        "repos",
        org.id,
        repositoryId,
        "checkouts",
      )
      expect(await readdir(checkouts)).toContain(`rev:${nextSha}`)
      expect(
        await releaseRunCheckout({
          orgId: org.id,
          sha: nextSha,
          runId: `run_${nextSha}`,
        }),
      ).toEqual({ deletedKeys: 1 })
      expect(
        await releaseRunCheckout({
          orgId: org.id,
          sha,
          runId: `run_${sha}`,
        }),
      ).toEqual({ deletedKeys: 0 })
      const left = await readdir(checkouts)
      expect(left).not.toContain(`rev:${nextSha}`)
      expect(left).toContain(`rev:${sha}`)
      await withOrgIdContext(org, async () => {
        expect(
          (await codeSearch(org.id, { workspaceId, query: "amberquartz" }))[0]
            ?.response.Files,
        ).toMatchObject([{ FileName: "AGENTS.md", Version: sha }])
      })
    }, true),
)

it(
  "chat SCIP queries resolve symbols from the published checkout",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, repositoryId } = f
      await prepareUnpublishedIndex(f)
      await installPublishedScipFixture(f)
      await withOrgIdContext(org, async () => {
        const capturedTools = await workspaceChatTools({
          orgId: org.id,
          orgSlug: org.slug,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        const graphTool = capturedTools.find(
          (tool) => tool.name === "graph_find_symbol",
        )
        const symbols = String(
          await graphTool?.execute({ repositoryId, symbol: "publishedHelper" }),
        )
        expect(symbols).toContain("publishedHelper")
        expect(symbols).toContain("sample.js")
      })
    }, true),
)

it(
  "chat structural search runs ast-grep against the published checkout",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, repositoryId } = f
      await prepareUnpublishedIndex(f)
      await withOrgIdContext(org, async () => {
        const capturedTools = await workspaceChatTools({
          orgId: org.id,
          orgSlug: org.slug,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        const structural = capturedTools.find(
          (tool) => tool.name === "structural_search",
        )
        const syntax = String(
          await structural?.execute({
            repositoryId,
            pattern: "function $NAME() { $$$BODY }",
            lang: "javascript",
            paths: ["sample.js"],
          }),
        )
        expect(syntax).toContain("publishedHelper")
        expect(syntax).toContain("sample.js")
        expect(syntax).not.toContain("unpublishedHelper")
      })
    }, true),
)

it(
  "a request body cannot override the signed search checkout",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { repositoryId, org, workspaceId } = f
      const nextSha = await prepareUnpublishedIndex(f)
      const boundToken = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: {
          sub: `repo:${repositoryId}`,
          orgId: org.id,
          principal: "service",
          workspaceId,
          workspaceRepositoryIds: [repositoryId],
        },
      })
      const forgedCheckoutSearch = await fetch(
        `${process.env.CODESEARCH_URL}/search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${boundToken}`,
          },
          body: JSON.stringify({
            Q: "amberquartz",
            checkoutKey: `ws:${workspaceId}:${nextSha}`,
          }),
        },
      )
      expect(forgedCheckoutSearch.status).toBe(200)
      expect(JSON.stringify(await forgedCheckoutSearch.json())).toContain(
        "AGENTS.md",
      )
    }, true),
)

it(
  "a Workspace token reads only the repositories that the Workspace links",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { repositoryId, org, workspaceId } = f
      const sign = (claims: Record<string, unknown>) =>
        signUpstreamJwt({
          env: parseEnv(process.env),
          audience: "codesearch",
          claims: {
            sub: `repo:${repositoryId}`,
            orgId: org.id,
            principal: "service",
            workspaceId,
            ...claims,
          },
        })
      const request = async (token: string, path: string) =>
        fetch(`${process.env.CODESEARCH_URL}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      // A token that lists no repository is refused.
      const unbound = await sign({})
      expect((await request(unbound, `/${repositoryId}/tree`)).status).toBe(401)
      // A token that lists another repository cannot read this one.
      const other = await sign({
        workspaceRepositoryIds: [generateObjectId("repo")],
      })
      for (const path of [
        `/${repositoryId}/tree`,
        `/${repositoryId}/files/AGENTS.md`,
      ])
        expect((await request(other, path)).status).toBe(403)
      const otherSearch = await fetch(`${process.env.CODESEARCH_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${other}`,
        },
        body: JSON.stringify({ Q: "amberquartz" }),
      })
      expect(otherSearch.status).toBe(200)
      expect(await otherSearch.json()).toEqual({ Files: [] })
      // The same search with a token that lists the repository finds it.
      const linked = await sign({ workspaceRepositoryIds: [repositoryId] })
      const linkedSearch = await fetch(`${process.env.CODESEARCH_URL}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${linked}`,
        },
        body: JSON.stringify({ Q: "amberquartz" }),
      })
      expect(linkedSearch.status).toBe(200)
      expect(JSON.stringify(await linkedSearch.json())).toContain("AGENTS.md")
    }, true),
)

it(
  "both clone and index reject a target that contradicts the signed revision",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { repositoryId, org, workspaceId } = f
      const nextSha = "b".repeat(40)
      const boundToken = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: {
          sub: `repo:${repositoryId}`,
          orgId: org.id,
          principal: "service",
          workspaceId,
          workspaceRepositoryIds: [repositoryId],
        },
      })
      for (const path of ["index/clone-checkout", "index"]) {
        const contradictory = await fetch(
          `${process.env.CODESEARCH_URL}/${repositoryId}/${path}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${boundToken}`,
            },
            body: JSON.stringify({ targetHash: nextSha }),
          },
        )
        expect(contradictory.status).toBe(403)
      }
    }, true),
)

it(
  "a new Workspace starts the ingestion of its repository and becomes code-readable when it publishes, with no new push",
  { timeout: 90_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { runner, indexInput, org, workspaceId, revision, repositoryId } = f
      // A new repository row has a `default` checkout before any ingestion.
      await withOrgDbContext(org.id, (db) =>
        db.insert(repositoryCheckouts).values({
          id: generateObjectId("co"),
          orgId: org.id,
          repositoryId,
          checkoutKey: "default",
          ref: "trunk",
        }),
      )
      const failed = await runner.runWorkflow(workspaceIndex.spec, indexInput)
      expect(await failed.result({ timeoutMs: 30_000 })).toEqual({
        published: false,
        role: "workspace",
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision,
          stores: { index: { kind: "failed" } },
        })
        expect(
          await codeSearch(org.id, { workspaceId, query: "amberquartz" }),
        ).toEqual([])
      })
      // The index started the ingestion of the repository.
      const requestId = await queuedIngestionRequest(f)
      // The ingestion publishes and queues the index of the Workspace.
      await f.publish(requestId)
      expect(await queuedWorkspaceIndexes(f)).toEqual([])
      expect(
        await withOrgIdContext(org, () =>
          enqueueWorkspaceIndexesAfterPublish(
            { orgId: org.id, repositoryId, sha: f.sha },
            { error: (error) => expect.unreachable(error.message) },
          ),
        ),
      ).toEqual({ queued: 1 })
      const queued = await queuedWorkspaceIndexes(f)
      expect(queued).toMatchObject([
        { orgId: org.id, revision: { workspaceId, sha: f.sha } },
      ])
      if (!queued[0]) throw new Error("No index job was queued")
      const indexed = await runner.runWorkflow(workspaceIndex.spec, queued[0])
      expect(await indexed.result({ timeoutMs: 30_000 })).toEqual({
        published: true,
        role: "workspace",
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision,
          stores: { index: { kind: "ready" } },
        })
        await expect
          .poll(
            async () =>
              (
                await codeSearch(org.id, { workspaceId, query: "amberquartz" })
              )[0]?.response.Files,
            { timeout: 10_000 },
          )
          .toMatchObject([{ FileName: "AGENTS.md" }])
      })
    }, false),
)

it(
  "a newly linked repository becomes code-readable when its ingestion publishes",
  { timeout: 90_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const {
        runner,
        org,
        workspaceId,
        remoteUrl,
        sha,
        revision,
        repositoryId,
      } = f
      const linkId = generateObjectId("wlr")
      await withOrgDbContext(org.id, (db) =>
        insertLinkedRepositoryRows(db, {
          id: linkId,
          orgId: org.id,
          workspaceId,
          gitUrl: remoteUrl,
          desiredRef: "trunk",
          desiredSha: sha,
        }),
      )
      const linked = {
        owner: revision,
        linkId,
        repositoryId,
        remote: revision.remote,
        ref: "trunk",
        sha,
      }
      const waiting = await runner.runWorkflow(workspaceIndex.spec, {
        orgId: org.id,
        revision,
        linked,
      })
      expect(await waiting.result({ timeoutMs: 30_000 })).toEqual({
        published: false,
        reason: "no_published_checkout",
      })
      await f.publish(await queuedIngestionRequest(f))
      await withOrgIdContext(org, () =>
        enqueueWorkspaceIndexesAfterPublish(
          { orgId: org.id, repositoryId, sha },
          { error: (error) => expect.unreachable(error.message) },
        ),
      )
      const queued = (await queuedWorkspaceIndexes(f)).find(
        (input) => input.linked,
      )
      expect(queued).toMatchObject({
        orgId: org.id,
        linked: { linkId, repositoryId, sha },
      })
      if (!queued) throw new Error("No linked index job was queued")
      const indexed = await runner.runWorkflow(workspaceIndex.spec, queued)
      expect(await indexed.result({ timeoutMs: 30_000 })).toEqual({
        published: true,
        role: "linked",
      })
    }, false),
)

it(
  "a repository whose ingestion predates revision checkouts stays readable from its `default` checkout",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, repositoryId, sha } = f
      // Before the upgrade, the ingestion wrote only the `default` row.
      await withOrgDbContext(org.id, async (db) => {
        await db
          .delete(repositoryCheckouts)
          .where(eq(repositoryCheckouts.repositoryId, repositoryId))
        await db.insert(repositoryCheckouts).values({
          id: generateObjectId("co"),
          orgId: org.id,
          repositoryId,
          checkoutKey: "default",
          ref: "trunk",
        })
      })
      await withOrgIdContext(org, async () => {
        expect(
          (await getWorkspaceProjectionSnapshot(workspaceId)).repositories,
        ).toMatchObject([{ id: repositoryId, sha, checkoutKey: "default" }])
      })
    }, true),
)

it(
  "a Workspace is ready after an ingestion whose Zoekt step failed: files read, and search finds nothing",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { runner, indexInput, org, workspaceId, repositoryId, cold } = f
      await f.publish()
      // The Zoekt step failed: the checkout exists, its shards do not.
      for (const name of await readdir(cold))
        await rm(join(cold, name), { force: true })
      const handle = await runner.runWorkflow(workspaceIndex.spec, indexInput)
      expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
        published: true,
        role: "workspace",
      })
      await withOrgIdContext(org, async () => {
        expect(
          await codeSearch(org.id, { workspaceId, query: "amberquartz" }),
        ).toEqual([])
        const tools = await workspaceChatTools({
          orgId: org.id,
          orgSlug: org.slug,
          workspaceId,
          snapshot: await getWorkspaceProjectionSnapshot(workspaceId),
        })
        const file = await tools
          .find((tool) => tool.name === "get_file")
          ?.execute({ repositoryId, path: "AGENTS.md", mode: "full" })
        expect(String(file)).toContain("Use amberquartz instructions.")
      })
    }, false),
)

it(
  "linked index publication rejects a changed owner identity",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, remoteUrl, sha, revision, repositoryId } = f
      const linkedId = generateObjectId("wlr")
      await withOrgDbContext(org.id, (db) =>
        insertLinkedRepositoryRows(db, {
          id: linkedId,
          orgId: org.id,
          workspaceId,
          gitUrl: remoteUrl,
          desiredRef: "trunk",
          desiredSha: sha,
        }),
      )
      const linkedPublication = {
        owner: revision,
        linkId: linkedId,
        repositoryId,
        remote: revision.remote,
        ref: "trunk",
        sha,
      }
      await withOrgIdContext(org, async () => {
        expect(await persistLinkedIndexedSha(linkedPublication)).toBe(true)
        await withOrgDbContext(org.id, (db) =>
          db
            .update(workspaces)
            .set({
              activeRevision: { ...revision, defaultBranch: "renamed" },
            })
            .where(eq(workspaces.id, workspaceId)),
        )
        expect(await persistLinkedIndexedSha(linkedPublication)).toBe(false)
      })
    }, true),
)

it(
  "linked index publication rejects a changed linked ref",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, remoteUrl, sha, revision, repositoryId } = f
      const linkedId = generateObjectId("wlr")
      await withOrgDbContext(org.id, (db) =>
        insertLinkedRepositoryRows(db, {
          id: linkedId,
          orgId: org.id,
          workspaceId,
          gitUrl: remoteUrl,
          desiredRef: "trunk",
          desiredSha: sha,
        }),
      )
      const linkedPublication = {
        owner: revision,
        linkId: linkedId,
        repositoryId,
        remote: revision.remote,
        ref: "trunk",
        sha,
      }
      await withOrgIdContext(org, async () => {
        expect(await persistLinkedIndexedSha(linkedPublication)).toBe(true)
        await withOrgDbContext(org.id, async (db) => {
          await db
            .update(workspaces)
            .set({ activeRevision: revision })
            .where(eq(workspaces.id, workspaceId))
          await setLinkedRepositoryRef(db, linkedId, "other")
        })
        expect(await persistLinkedIndexedSha(linkedPublication)).toBe(false)
      })
    }, true),
)

it(
  "cron refresh captures a default-branch rename once at the same SHA",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { git, runner, org, workspaceId, revision, sha } = f
      git("branch", "-m", "trunk", "renamed")
      const tipCheck = await runner.runWorkflow(workspaceTipCheck.spec, {
        orgId: org.id,
      })
      expect(await tipCheck.result({ timeoutMs: 30_000 })).toEqual({
        updated: 1,
        linkedUpdated: 0,
      })
      const sameTip = await runner.runWorkflow(workspaceTipCheck.spec, {
        orgId: org.id,
      })
      expect(await sameTip.result({ timeoutMs: 30_000 })).toEqual({
        updated: 0,
        linkedUpdated: 0,
      })
      await withOrgIdContext(org, async () => {
        const refreshed = await resolveWorkspaceReadRevision({
          orgId: org.id,
          workspaceId,
          env: parseEnv(process.env),
          refresh: true,
        })
        expect(refreshed?.revision).toEqual({
          ...revision,
          defaultBranch: "renamed",
        })
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "building",
          desired: { defaultBranch: "renamed", sha },
          previous: { kind: "active", revision },
        })
        git("branch", "-m", "renamed", "trunk")
        expect(
          (
            await resolveWorkspaceReadRevision({
              orgId: org.id,
              workspaceId,
              env: parseEnv(process.env),
              refresh: true,
            })
          )?.revision,
        ).toEqual(revision)
      })
    }, true),
)

it.each(["pending", "failed"])(
  "serves the last complete index while the active replacement index is %s",
  { timeout: 60_000 },
  async (state) =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, revision } = f
      const nextSha = await prepareUnpublishedIndex(f)
      await withOrgIdContext(org, async () => {
        const next = await captureWorkspaceRevision({
          workspaceId,
          expected: {
            generation: revision.generation,
            url: revision.remote.url,
            sha: revision.sha,
            defaultBranch: revision.defaultBranch,
            githubConnectionId: revision.remote.connectionId,
          },
          tip: { sha: nextSha, branch: revision.defaultBranch },
        })
        if (!next) throw new Error("Replacement revision was not captured")
        expect(
          await commitHydrateProjection({
            orgId: org.id,
            revision: next,
            displayName: null,
            formatVersion: 0,
            units: [],
            skipped: [],
            embeddingModel: "fixture-embedding",
          }),
        ).toBe(true)
        if (state === "failed") {
          expect(
            await persistWorkspaceIndexResult({
              revision: next,
              result: { kind: "failed", message: "Replacement index failed" },
            }),
          ).toBe(true)
        }
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision: next,
          stores: { index: { kind: state } },
        })
        const matches = await codeSearch(org.id, {
          workspaceId,
          query: "amberquartz",
        })
        expect(matches[0]?.response.Files).toMatchObject([
          { FileName: "AGENTS.md" },
        ])
        expect(await getWorkspaceSearchProjection(workspaceId)).toMatchObject({
          repositories: [{ sha: revision.sha }],
        })
      })
    }, true),
)

it(
  "cron retries an unactivated full revision even after its same-SHA tip was captured",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { git, runner, org, workspaceId } = f
      git("branch", "-m", "trunk", "renamed")
      const hydrates = sql`
      from openworkflow.workflow_runs
      where workflow_name = 'workspace-hydrate' and input->>'workspaceId' = ${workspaceId}
    `
      for (const updated of [1, 0]) {
        const handle = await runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: org.id,
        })
        expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
          updated,
          linkedUpdated: 0,
        })
        const queued = await getSystemDb().execute<{
          input: { revision: WorkspaceRevision }
        }>(sql`select input ${hydrates}`)
        expect(
          queued.rows.map((row) => row.input.revision.defaultBranch),
        ).toEqual(["renamed"])
        // The queued hydrate is lost. An unfinished one would block a
        // second hydrate of the same SHA.
        await getSystemDb().execute(sql`delete ${hydrates}`)
      }
    }, true),
)

it(
  "chat get_file reads the published checkout after the remote is gone, and a new snapshot drops an unlinked repository",
  { timeout: 60_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot,
      })
      await unlinkWorkspaceRepository(f)
      await rename(f.remote, `${f.remote}-unavailable`)
      const result = await tools
        .find((tool) => tool.name === "get_file")
        ?.execute({
          repositoryId: f.repositoryId,
          path: "AGENTS.md",
          mode: "full",
          sha: "b".repeat(40),
        })
      expect(String(result)).toContain("Use amberquartz instructions.")
      expect(
        String(
          await (await freshChatTool(f, "get_file"))?.execute({
            repositoryId: f.repositoryId,
            path: "AGENTS.md",
          }),
        ),
      ).toContain("repository_not_in_workspace")
    })
  },
)

it(
  "chat glob_files reads the published checkout after the remote is gone, and a new snapshot drops an unlinked repository",
  { timeout: 60_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        orgSlug: f.org.slug,
        workspaceId: f.workspaceId,
        snapshot,
      })
      await unlinkWorkspaceRepository(f)
      await rename(f.remote, `${f.remote}-unavailable`)
      const result = await tools
        .find((tool) => tool.name === "glob_files")
        ?.execute({
          repositoryId: f.repositoryId,
          pattern: "*.js",
          onlyFiles: true,
          sha: "b".repeat(40),
        })
      expect(String(result)).toContain("sample.js")
      expect(
        String(
          await (await freshChatTool(f, "glob_files"))?.execute({
            repositoryId: f.repositoryId,
            pattern: "*.js",
          }),
        ),
      ).toContain("repository_not_in_workspace")
    })
  },
)
