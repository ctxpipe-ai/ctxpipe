import {
  withNativeIndexFixture,
  type NativeIndexFixture,
} from "../../test/native-index-fixture.js"
import { signUpstreamJwt } from "../../auth/upstreamJwt.js"
import { encodeScipIndex } from "../../../../codesearch/src/domain/graph/scipProto.js"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { eq, sql } from "drizzle-orm"
import { expect, it } from "vitest"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { repositories } from "../../db/schema/repositories.js"
import { repositoryCheckouts } from "../../db/schema/repository_checkouts.js"
import {
  workspaceLinkedRepositories,
  workspaces,
} from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  persistWorkspaceIndexResult,
  getWorkspaceById,
  persistLinkedIndexedSha,
  getWorkspaceProjection,
  getWorkspaceProjectionSnapshot,
  getWorkspaceSearchProjection,
} from "../../models/workspaces.js"
import { ensureWorkspaceCheckout } from "../../models/repositories.js"
import { repositoryIndex } from "../../openworkflow/workflows/repository-index.js"
import { workspaceTipCheck } from "../../openworkflow/workflows/workspace-tip-check.js"
import { workspaceIndex } from "../../openworkflow/workflows/workspace-index.js"
import { codeSearch } from "../../retrieval/services/codeSearch.js"
import { parseEnv } from "../../config/env.js"
import { resolveWorkspaceReadRevision } from "./resolve-revision.js"
import { workspaceChatTools } from "./workspace-chat-tools.js"
import type { WorkspaceRevision } from "./revision.js"

async function prepareUnpublishedIndex(f: NativeIndexFixture) {
  const { remote, git, org, repositoryId, workspaceId, runner, revision } = f
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
  await withOrgIdContext(org, () =>
    ensureWorkspaceCheckout({ repositoryId, workspaceId, ref: nextSha }),
  )
  const unpublishedIndex = await runner.runWorkflow(repositoryIndex.spec, {
    repositoryId,
    orgId: org.id,
    workspaceId,
    targetHash: nextSha,
    jobGeneration: 1,
    jobWorkspaceUrl: remote,
    revision: { ...revision, sha: nextSha },
  })
  expect(await unpublishedIndex.result({ timeoutMs: 30_000 })).toMatchObject({
    searchIndexOk: true,
    targetHash: nextSha,
  })
  return nextSha
}

async function installPublishedScipFixture(f: NativeIndexFixture) {
  const { directory, org, repositoryId, workspaceId, sha } = f
  const symbol =
    "scip-typescript npm fixture 1.0.0 sample.js/publishedHelper()."
  await writeFile(
    join(
      directory,
      "repos",
      org.id,
      repositoryId,
      "checkouts",
      `ws:${workspaceId}:${sha}.scip`,
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

it(
  "rejects contradictory and unbound queued index revisions",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { runner, repositoryId, org, workspaceId, sha, remote, revision } =
        f
      await expect(
        runner.runWorkflow(repositoryIndex.spec, {
          repositoryId,
          orgId: org.id,
          workspaceId,
          targetHash: sha,
          jobGeneration: 2,
          jobWorkspaceUrl: remote,
          revision,
        }),
      ).rejects.toThrow(
        "Repository index input must describe one workspace revision",
      )
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
      await expect(
        runner.runWorkflow(repositoryIndex.spec, {
          repositoryId,
          orgId: org.id,
          workspaceId,
          targetHash: sha,
        }),
      ).rejects.toThrow(
        "Workspace indexing requires exactly one captured revision",
      )
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
      const { org, workspaceId, repositoryId, sha, revision, remote } = f
      await withOrgIdContext(org, async () => {
        const chatTools = await workspaceChatTools({
          orgId: org.id,
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
                url: remote,
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
      const { repositoryId, org, workspaceId, sha } = f
      const nextSha = await prepareUnpublishedIndex(f)
      const boundToken = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: {
          sub: `repo:${repositoryId}`,
          orgId: org.id,
          principal: "service",
          workspaceId,
          workspaceRevisions: [{ repositoryId, sha }],
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
  "an explicit legacy workspace with no checkout returns no search matches",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { repositoryId, org } = f
      const missingCheckoutToken = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: {
          sub: `repo:${repositoryId}`,
          orgId: org.id,
          principal: "service",
          workspaceId: generateObjectId("ws"),
          legacyWorkspace: true,
        },
      })
      const missingCheckoutSearch = await fetch(
        `${process.env.CODESEARCH_URL}/search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${missingCheckoutToken}`,
          },
          body: JSON.stringify({ Q: "amberquartz" }),
        },
      )
      expect(missingCheckoutSearch.status).toBe(200)
      expect(await missingCheckoutSearch.json()).toEqual({ Files: [] })
    }, true),
)

it(
  "both clone and index reject a target that contradicts the signed revision",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { repositoryId, org, workspaceId, sha } = f
      const nextSha = "b".repeat(40)
      const boundToken = await signUpstreamJwt({
        env: parseEnv(process.env),
        audience: "codesearch",
        claims: {
          sub: `repo:${repositoryId}`,
          orgId: org.id,
          principal: "service",
          workspaceId,
          workspaceRevisions: [{ repositoryId, sha }],
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
  "an initial search-index failure preserves Postgres and a retry publishes search",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { cold, runner, indexInput, org, workspaceId, revision } = f
      await rename(cold, `${cold}-previous`)
      await writeFile(cold, "This fixture prevents search index output")
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
      await rm(cold)
      await rename(`${cold}-previous`, cold)
      const retried = await runner.runWorkflow(workspaceIndex.spec, indexInput)
      expect(await retried.result({ timeoutMs: 30_000 })).toEqual({
        published: true,
        role: "workspace",
      })
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          kind: "active",
          revision,
          stores: { index: { kind: "ready" } },
        })
      })
    }, false),
)

it(
  "linked index publication rejects a changed owner identity",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, remote, sha, revision, repositoryId } = f
      const linkedId = generateObjectId("wlr")
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaceLinkedRepositories).values({
          id: linkedId,
          orgId: org.id,
          workspaceId,
          gitUrl: remote,
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
      const { org, workspaceId, remote, sha, revision, repositoryId } = f
      const linkedId = generateObjectId("wlr")
      await withOrgDbContext(org.id, (db) =>
        db.insert(workspaceLinkedRepositories).values({
          id: linkedId,
          orgId: org.id,
          workspaceId,
          gitUrl: remote,
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
          await db
            .update(workspaceLinkedRepositories)
            .set({ desiredRef: "other" })
            .where(eq(workspaceLinkedRepositories.id, linkedId))
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

it(
  "index admission rejects a repository bound to another remote",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, remote, runner, workspaceId, sha, revision } = f
      const otherRepositoryId = generateObjectId("repo")
      await withOrgDbContext(org.id, (db) =>
        db.insert(repositories).values({
          id: otherRepositoryId,
          orgId: org.id,
          name: "Other remote",
          gitUrl: `${remote}-other`,
        }),
      )
      const mismatched = await runner.runWorkflow(repositoryIndex.spec, {
        repositoryId: otherRepositoryId,
        orgId: org.id,
        workspaceId,
        targetHash: sha,
        jobGeneration: 1,
        jobWorkspaceUrl: remote,
        revision,
      })
      await expect(mismatched.result({ timeoutMs: 10_000 })).rejects.toThrow(
        "Index repository does not match the captured revision",
      )
      await withOrgIdContext(org, async () => {
        expect(await getWorkspaceProjection(workspaceId)).toMatchObject({
          stores: { index: { kind: "ready" } },
        })
      })
    }, true),
)

it(
  "unbound default indexing cannot mark a workspace index ready",
  { timeout: 60_000 },
  async () =>
    withNativeIndexFixture(async (f) => {
      const { org, workspaceId, repositoryId, runner, sha } = f
      await withOrgDbContext(org.id, async (db) => {
        await db
          .update(workspaces)
          .set({
            activeRevision: null,
            activeProjectionSha: null,
            activeProjectionUrl: null,
            indexedSha: null,
          })
          .where(eq(workspaces.id, workspaceId))
        await db.insert(repositoryCheckouts).values({
          id: generateObjectId("co"),
          orgId: org.id,
          repositoryId,
          checkoutKey: "default",
          ref: "trunk",
        })
      })
      await expect(
        runner.runWorkflow(repositoryIndex.spec, {
          repositoryId,
          orgId: org.id,
          workspaceId,
          targetHash: sha,
        }),
      ).rejects.toThrow(
        "Workspace indexing requires exactly one captured revision",
      )
      await withOrgIdContext(org, async () => {
        expect((await getWorkspaceById(workspaceId))?.indexedSha).toBeNull()
      })
    }, false),
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
            remotes: [],
            units: [],
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
      for (const updated of [1, 0]) {
        const handle = await runner.runWorkflow(workspaceTipCheck.spec, {
          orgId: org.id,
        })
        expect(await handle.result({ timeoutMs: 30_000 })).toEqual({
          updated,
          linkedUpdated: 0,
        })
      }
      const queued = await getSystemDb().execute<{
        input: { revision: WorkspaceRevision }
      }>(sql`
      select input from openworkflow.workflow_runs
      where workflow_name = 'workspace-hydrate' and input->>'workspaceId' = ${workspaceId}
    `)
      expect(
        queued.rows.map((row) => row.input.revision.defaultBranch),
      ).toEqual(["renamed", "renamed"])
    }, true),
)

it(
  "chat get_file reads its captured index after membership and remote removal",
  { timeout: 60_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        snapshot,
      })
      await withOrgDbContext(f.org.id, (db) =>
        db
          .delete(repositoryCheckouts)
          .where(eq(repositoryCheckouts.repositoryId, f.repositoryId)),
      )
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
    })
  },
)

it(
  "chat glob_files keeps its captured checkout after membership and remote removal",
  { timeout: 60_000 },
  async () => {
    await withNativeIndexFixture(async (f) => {
      const snapshot = await withOrgIdContext(f.org, () =>
        getWorkspaceProjectionSnapshot(f.workspaceId),
      )
      const tools = await workspaceChatTools({
        orgId: f.org.id,
        workspaceId: f.workspaceId,
        snapshot,
      })
      await withOrgDbContext(f.org.id, (db) =>
        db
          .delete(repositoryCheckouts)
          .where(eq(repositoryCheckouts.repositoryId, f.repositoryId)),
      )
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
    })
  },
)
