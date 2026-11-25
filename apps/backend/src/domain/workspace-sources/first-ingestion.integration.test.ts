import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { beforeAll, expect, it, vi } from "vitest"

import { withOrgIdContext } from "../../auth/withAuth.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { codesearchBaseUrl } from "../../lib/agentToolRuntime.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveRepositoryRef } from "../codeIngestion/queue.js"
import { linkPlainGitSource } from "./first-ingestion.js"
import { plainGitPins } from "./plain-git-pin.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

const SOURCE_PATH = "sources/git/git.example.org/team-app.md"
const SOURCE_URL = "https://git.example.org/team/app"

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

/** The text of the plain git source file, with an optional pinned commit. */
const sourceText = (commit?: string) =>
  `---\nprovider: git\nurl: ${SOURCE_URL}.git\n${commit ? `commit: ${commit}\n` : ""}---\n`

/**
 * Run `check` on a published Workspace whose plain git host resolves to a
 * public address, while each git read of the host goes to the local
 * fixture repository.
 */
async function withPlainGitWorkspace(
  check: (f: Fixture) => Promise<void>,
): Promise<void> {
  vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
  try {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        const restore = usePlainGitNetwork({
          lookup: async () => [{ address: "140.82.112.3" }],
          gitConfig: [[`url.${f.remote}.insteadOf`, SOURCE_URL]],
        })
        try {
          await check(f)
        } finally {
          restore()
        }
      },
    )
  } finally {
    vi.unstubAllEnvs()
  }
}

/** Merge `text` as the plain git source file, and hydrate the Workspace. */
async function mergeSource(f: Fixture, text: string): Promise<void> {
  mkdirSync(join(f.directory, "sources/git/git.example.org"), {
    recursive: true,
  })
  writeFileSync(join(f.directory, SOURCE_PATH), text)
  f.git("add", "sources")
  f.git(
    "-c",
    "user.name=Human",
    "-c",
    "user.email=human@example.test",
    "commit",
    "-m",
    "Change the plain git source",
  )
  f.git("push", f.remote, "HEAD:refs/heads/main")
  const hydrate = await f.runner.runWorkflow(workspaceHydrate.spec, {
    orgId: f.org.id,
    workspaceId: f.workspaceId,
    revision: await f.resolveRevision(true),
  })
  expect(await hydrate.result({ timeoutMs: 60_000 })).toMatchObject({
    hydrated: true,
  })
}

async function sourceRow(orgId: string) {
  const [source] = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(workspaceSources)
      .where(eq(workspaceSources.sourceKey, SOURCE_PATH)),
  )
  return source
}

async function repositoryId(orgId: string): Promise<string> {
  const [repository] = await withOrgDbContext(orgId, (db) =>
    db
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.gitUrl, SOURCE_URL)),
  )
  if (!repository) throw new Error("The plain git repository has no row")
  return repository.id
}

/** True when an org ingestion of the repository is requested. */
async function ingestionRequested(orgId: string): Promise<boolean> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({ gitUrl: repositoryIngestionRequests.repositoryUrl })
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.orgId, orgId)),
  )
  return rows.some((row) => row.gitUrl === SOURCE_URL)
}

/**
 * The org ingestion of the repository published `sha`, and its request is
 * done: the next request is a new ingestion.
 */
async function ingested(orgId: string, sha: string): Promise<void> {
  await withOrgDbContext(orgId, async (db) => {
    await db
      .update(repositories)
      .set({ lastIngestedHash: sha })
      .where(eq(repositories.gitUrl, SOURCE_URL))
    await db
      .delete(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.orgId, orgId))
  })
}

/** The pin that applies to the repository, or null. */
const pinOf = async (orgId: string) =>
  (
    await plainGitPins({
      orgId,
      gitUrl: SOURCE_URL,
      githubConnectionId: null,
    })
  ).pin

const resolve = (orgId: string, id: string) =>
  withLogger(createLogger({}), () =>
    resolveRepositoryRef({ repositoryId: id, orgId }),
  )

it(
  "links the repository of a merged plain git source and starts its first ingestion",
  { timeout: 120_000 },
  async () => {
    await withPlainGitWorkspace(async (f) => {
      await mergeSource(f, sourceText())
      expect(await sourceRow(f.org.id)).toMatchObject({
        provider: "git",
        connectionId: null,
        status: "ok",
      })
      // The link makes the org repository row with no connection, and
      // starts its first org ingestion.
      const rows = await withOrgDbContext(f.org.id, (db) =>
        db
          .select({
            gitUrl: repositories.gitUrl,
            githubConnectionId: repositories.githubConnectionId,
          })
          .from(repositories)
          .where(eq(repositories.orgId, f.org.id)),
      )
      expect(rows).toContainEqual({
        gitUrl: SOURCE_URL,
        githubConnectionId: null,
      })
      expect(await ingestionRequested(f.org.id)).toBe(true)
    })
  },
)

it(
  "ingests a pinned plain git source at its commit, and again when the pin changes or goes",
  { timeout: 180_000 },
  async () => {
    await withPlainGitWorkspace(async (f) => {
      const first = f.git("rev-parse", "HEAD")
      await mergeSource(f, sourceText(first))
      expect(await sourceRow(f.org.id)).toMatchObject({
        status: "ok",
        scope: { url: `${SOURCE_URL}.git`, commit: first },
      })
      expect(await ingestionRequested(f.org.id)).toBe(true)
      const id = await repositoryId(f.org.id)
      // The tip of main is the commit that added the source. Each
      // ingestion of the repository (and a re-ingestion) reads the pinned
      // commit, and asks the host for no branch tip.
      expect(f.git("rev-parse", "HEAD")).not.toBe(first)
      expect(await resolve(f.org.id, id)).toEqual({
        branch: "HEAD",
        hash: first,
      })
      expect(await pinOf(f.org.id)).toBe(first)
      // A repository that a GitHub connection reads has no pin, also for a
      // caller that does not know the binding (the re-ingestion).
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(repositories)
          .set({ githubConnectionId: f.connectionId })
          .where(eq(repositories.id, id)),
      )
      expect(
        (await plainGitPins({ orgId: f.org.id, gitUrl: SOURCE_URL })).pin,
      ).toBeNull()
      await withOrgDbContext(f.org.id, (db) =>
        db
          .update(repositories)
          .set({ githubConnectionId: null })
          .where(eq(repositories.id, id)),
      )

      // The org published the pinned commit: the next hydrate starts no
      // ingestion.
      await ingested(f.org.id, first)
      await mergeSource(f, `${sourceText(first)}\nThe app at its release.\n`)
      expect(await ingestionRequested(f.org.id)).toBe(false)

      // A changed pin starts an ingestion of the new commit.
      const second = f.git("rev-parse", "HEAD")
      await mergeSource(f, sourceText(second))
      expect(await ingestionRequested(f.org.id)).toBe(true)
      expect(await resolve(f.org.id, id)).toEqual({
        branch: "HEAD",
        hash: second,
      })

      // A removed pin starts an ingestion, which follows the branch again.
      await ingested(f.org.id, second)
      await mergeSource(f, sourceText())
      expect(await ingestionRequested(f.org.id)).toBe(true)
      expect(await pinOf(f.org.id)).toBeNull()
    })
  },
)

it.each([
  ["pins it at another commit", "a".repeat(40)],
  ["names it with no pin", null],
])(
  "follows the branch when another Workspace of the org %s",
  { timeout: 120_000 },
  async (_, otherCommit) => {
    await withPlainGitWorkspace(async (f) => {
      const first = f.git("rev-parse", "HEAD")
      await mergeSource(f, sourceText(first))
      await ingested(f.org.id, first)
      // Another Workspace of the org names the same repository: its
      // projection wrote this row, then links its source.
      const other = `${f.workspaceId}_other`
      const scope = {
        url: SOURCE_URL,
        ...(otherCommit ? { commit: otherCommit } : {}),
      }
      await withOrgDbContext(f.org.id, async (db) => {
        await db.insert(workspaces).values({
          id: other,
          orgId: f.org.id,
          slug: "other",
          displayName: "Other",
          workspaceRepositoryUrl: "https://github.com/acme/other",
        })
        await db.insert(workspaceSources).values({
          id: `${other}_source`,
          orgId: f.org.id,
          workspaceId: other,
          sourceKey: SOURCE_PATH,
          provider: "git",
          scope,
          status: "ok",
          revision: "b".repeat(40),
        })
      })
      await withOrgIdContext(f.org, () =>
        linkPlainGitSource({ orgId: f.org.id, scope }),
      )

      // The sources do not agree: the repository leaves the old pin, and
      // its ingestion reads the tip of the branch.
      expect(await ingestionRequested(f.org.id)).toBe(true)
      const tip = f.git("rev-parse", "HEAD")
      f.server.use(
        http.post(`${codesearchBaseUrl()}/:id/resolve-ref`, () =>
          HttpResponse.json({ branch: "main", hash: tip }),
        ),
      )
      expect(await resolve(f.org.id, await repositoryId(f.org.id))).toEqual({
        branch: "main",
        hash: tip,
      })
    })
  },
)
