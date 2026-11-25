import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { eq } from "drizzle-orm"
import { beforeAll, expect, it, vi } from "vitest"

import { withOrgDbContext } from "../../db/client.js"
import {
  repositories,
  repositoryIngestionRequests,
} from "../../db/schema/repositories.js"
import { workspaceSources } from "../../db/schema/workspace_sources.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { workspaceHydrate } from "../../openworkflow/workflows/workspace-hydrate.js"
import { usePlainGitNetwork } from "../../services/git/plain-git-remote.js"
import { withNativeHydrationFixture } from "../../test/native-hydration-fixture.js"
import { resolveRepositoryRef } from "../codeIngestion/queue.js"

beforeAll(() => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required: run pnpm dev:infra")
})

const SOURCE_PATH = "sources/git/git.example.org/team-app.md"
const SOURCE_URL = "https://git.example.org/team/app"

type Fixture = Parameters<Parameters<typeof withNativeHydrationFixture>[1]>[0]

/**
 * Merge the plain git source file that `text` gives, hydrate the Workspace,
 * and call `check`. `before` is the tip of main before the merge.
 */
async function withMergedPlainGitSource(
  text: (before: string) => string,
  check: (f: Fixture, before: string) => Promise<void>,
): Promise<void> {
  vi.stubEnv("SANDBOX_PROVIDER", "agentcore")
  try {
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.publish()
        // The plain git host resolves to a public address, and each git
        // read of it goes to the local fixture repository.
        const restore = usePlainGitNetwork({
          lookup: async () => [{ address: "140.82.112.3" }],
          gitConfig: [[`url.${f.remote}.insteadOf`, SOURCE_URL]],
        })
        try {
          const before = f.git("rev-parse", "HEAD")
          mkdirSync(join(f.directory, "sources/git/git.example.org"), {
            recursive: true,
          })
          writeFileSync(join(f.directory, SOURCE_PATH), text(before))
          f.git("add", "sources")
          f.git(
            "-c",
            "user.name=Human",
            "-c",
            "user.email=human@example.test",
            "commit",
            "-m",
            "Add a plain git source",
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
          await check(f, before)
        } finally {
          restore()
        }
      },
    )
  } finally {
    vi.unstubAllEnvs()
  }
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

async function requestedUrls(orgId: string): Promise<string[]> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({ gitUrl: repositoryIngestionRequests.repositoryUrl })
      .from(repositoryIngestionRequests)
      .where(eq(repositoryIngestionRequests.orgId, orgId)),
  )
  return rows.map((row) => row.gitUrl)
}

it(
  "links the repository of a merged plain git source and starts its first ingestion",
  { timeout: 120_000 },
  async () => {
    await withMergedPlainGitSource(
      () => `---\nprovider: git\nurl: ${SOURCE_URL}.git\n---\n`,
      async (f) => {
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
        expect(await requestedUrls(f.org.id)).toContain(SOURCE_URL)
      },
    )
  },
)

it(
  "ingests a pinned plain git source at its commit, not at the branch tip",
  { timeout: 120_000 },
  async () => {
    await withMergedPlainGitSource(
      (before) =>
        `---\nprovider: git\nurl: ${SOURCE_URL}.git\ncommit: ${before}\n---\n`,
      async (f, before) => {
        expect(await sourceRow(f.org.id)).toMatchObject({
          status: "ok",
          scope: { url: `${SOURCE_URL}.git`, commit: before },
        })
        expect(await requestedUrls(f.org.id)).toContain(SOURCE_URL)
        const [repository] = await withOrgDbContext(f.org.id, (db) =>
          db
            .select({ id: repositories.id })
            .from(repositories)
            .where(eq(repositories.gitUrl, SOURCE_URL)),
        )
        // The tip of main is the commit that added the source. Each
        // ingestion of the repository resolves the pinned commit, and asks
        // codesearch for no branch tip.
        expect(f.git("rev-parse", "HEAD")).not.toBe(before)
        expect(
          await withLogger(createLogger({}), () =>
            resolveRepositoryRef({
              repositoryId: repository?.id ?? "",
              orgId: f.org.id,
            }),
          ),
        ).toEqual({ branch: "HEAD", hash: before })
      },
    )
  },
)
