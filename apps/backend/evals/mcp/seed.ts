import { execFileSync } from "node:child_process"
import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import { getAuth } from "../../src/auth/config.js"
import { withUserIdContext } from "../../src/auth/context.js"
import { setOrganizations } from "../../src/auth/oauth-grants.js"
import { withOrgIdContext } from "../../src/auth/withAuth.js"
import { getSystemDb } from "../../src/db/client.js"
import { members, organizations } from "../../src/db/schema/auth.js"
import {
  type CodesearchIndexAuth,
  codesearchIndexCloneCheckout,
  codesearchIndexDetectLanguages,
  codesearchIndexMergeScip,
  codesearchIndexScipLang,
  codesearchIndexZoekt,
} from "../../src/domain/codeIngestion/codesearchIndexPhases.js"
import { workspaceCheckoutKey } from "../../src/domain/workspaces/derived-stores.js"
import { projectWorkspaceGraph } from "../../src/domain/workspaces/graph-projection.js"
import { hydrateKnowledgeTree } from "../../src/domain/workspaces/hydrate.js"
import {
  createOrGetRepository,
  ensureRepositoryRevisionCheckout,
  ensureWorkspaceCheckout,
  markRepositoryIndexingReady,
} from "../../src/models/repositories.js"
import { replaceWorkspaceSourceRows } from "../../src/models/workspace-sources.js"
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  createWorkspace,
  embedKnowledgeChunks,
  getDesiredWorkspaceRevision,
  getLinkedReadBinding,
  getWorkspaceBySlug,
  getWorkspaceProjection,
  listLinkedRepositories,
  markKnowledgeEmbeddingsReady,
  persistLinkedDesiredSha,
  persistLinkedIndexedSha,
  persistWorkspaceIndexResult,
} from "../../src/models/workspaces.js"
import {
  embeddingModelId,
  generateEmbeddings,
} from "../../src/retrieval/services/modelProvider.js"
import {
  listMarkdownFilesAtGitSha,
  resolveGitRemoteTip,
} from "../../src/services/git/clone-tree.js"
import manifestJson from "./fixtures/manifest.json"

// TypeScript infers each `updatedAt` object of the JSON as its own literal
// type, and that union does not fit `Record<string, string>`. Parse the JSON
// to get one type and to check the fixture.
const manifest = z
  .object({
    commitDate: z.string(),
    organizations: z.array(z.object({ key: z.string(), name: z.string() })),
    upstreamRepositories: z.array(
      z.object({
        key: z.string(),
        url: z.string(),
        sha: z.string(),
        tag: z.string(),
      }),
    ),
    workspaces: z.array(
      z.object({
        key: z.string(),
        organization: z.string(),
        slug: z.string(),
        name: z.string(),
        repositories: z.array(z.string()),
        updatedAt: z.record(z.string(), z.string()),
      }),
    ),
    secondProjection: z.object({
      workspace: z.string(),
      branch: z.string(),
      date: z.string(),
    }),
  })
  .parse(manifestJson)

export { manifest as mcpEvalManifest }

function fixtureGit(cwd: string, date: string, ...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=MCP Eval",
      "-c",
      "user.email=mcp-eval@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    {
      cwd,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    },
  )
}

/**
 * Create immutable fixture repositories; the caller owns their lifetime.
 * Each file gets its manifest date as its last-commit time. The second
 * projection is one more commit on its own branch; the `main` tip is the first.
 */
export async function prepareMcpEvalRepositories(
  directory: string,
): Promise<Record<string, string>> {
  await mkdir(directory)
  const remotes: Record<string, string> = {}
  for (const workspace of manifest.workspaces) {
    const source = fileURLToPath(
      new URL(`./fixtures/${workspace.key}/`, import.meta.url),
    )
    const checkout = join(directory, `${workspace.key}-checkout`)
    const remote = join(directory, workspace.key)
    await cp(source, checkout, { recursive: true })
    const git = (date: string, ...args: string[]) =>
      fixtureGit(checkout, date, ...args)
    git(
      manifest.commitDate,
      "init",
      "--initial-branch=main",
      "--object-format=sha1",
      "--template=",
    )
    const dates: Record<string, string> = workspace.updatedAt
    const byDate = new Map<string, string[]>()
    for (const path of git(manifest.commitDate, "ls-files", "--others", "-z")
      .toString("utf8")
      .split("\0")
      .filter(Boolean)) {
      const date = dates[path] ?? manifest.commitDate
      byDate.set(date, [...(byDate.get(date) ?? []), path])
    }
    for (const date of [...byDate.keys()].sort()) {
      git(date, "add", "--", ...(byDate.get(date) ?? []))
      git(date, "commit", "-m", "Seed synthetic MCP context")
    }
    git(manifest.commitDate, "clone", "--bare", checkout, remote)
    remotes[workspace.key] = pathToFileURL(remote).href
    const second = manifest.secondProjection
    if (second.workspace === workspace.key) {
      git(second.date, "checkout", "-b", second.branch)
      await cp(
        fileURLToPath(
          new URL(`./fixtures/${workspace.key}.next/`, import.meta.url),
        ),
        checkout,
        { recursive: true },
      )
      git(second.date, "add", ".")
      git(second.date, "commit", "-m", "Move to the second projection")
      git(second.date, "push", remote, second.branch)
      git(second.date, "checkout", "main")
    }
  }
  return remotes
}

async function indexRepository(
  auth: CodesearchIndexAuth,
  sha: string,
  checkoutKey: string,
) {
  const checkout = await codesearchIndexCloneCheckout(auth, {
    targetHash: sha,
    checkoutKey,
  })
  if (checkout.targetHash !== sha)
    throw new Error("Codesearch returned a different fixture revision")
  await codesearchIndexZoekt(auth)
  const languages = await codesearchIndexDetectLanguages(auth, checkout)
  for (const language of languages.languagesToIndex) {
    const result = await codesearchIndexScipLang(
      auth,
      language,
      languages.detectedLanguages,
    )
    if (result.issue)
      throw new Error(`Fixture SCIP index failed: ${result.issue}`)
  }
  await codesearchIndexMergeScip(
    auth,
    languages.detectedLanguages,
    languages.languagesToIndex,
  )
}

type FixtureWorkspace = (typeof manifest.workspaces)[number]
type FixtureUpstream = (typeof manifest.upstreamRepositories)[number]
type FixtureOrg = { id: string; slug: string }

/**
 * Publish one revision of a Workspace: units, chunks, embeddings, graph, and
 * the Workspace search index. This mirrors the `workspace-hydrate`,
 * `workspace-index`, and `repository-index` workflows without a queue. The
 * workflows cannot run here: hydrate puts write jobs and GitHub backfills on
 * the shared queue, where a live backend worker would run them against the
 * fixture organizations. The domain calls below are the ones that those
 * workflows make; keep them in step.
 */
async function publishWorkspaceRevision(input: {
  org: FixtureOrg
  fixture: FixtureWorkspace
  workspace: { id: string; workspaceRepositoryUrl: string }
  revision: NonNullable<Awaited<ReturnType<typeof captureWorkspaceRevision>>>
  files: Awaited<ReturnType<typeof listMarkdownFilesAtGitSha>>
}) {
  const { org, fixture, workspace, revision, files } = input
  const parsed = hydrateKnowledgeTree({
    workspaceId: workspace.id,
    workspaceUrl: revision.remote.url,
    files,
  })
  if (parsed.skipped.length)
    throw new Error("Fixture contains invalid Markdown")
  if (
    !(await commitHydrateProjection({
      orgId: org.id,
      revision,
      displayName: fixture.name,
      units: parsed.units,
      skipped: parsed.skipped,
      embeddingModel: embeddingModelId(),
    }))
  )
    throw new Error("Fixture projection changed before publication")
  await embedKnowledgeChunks({
    workspaceId: workspace.id,
    embed: generateEmbeddings,
  })
  if (!(await markKnowledgeEmbeddingsReady({ revision })))
    throw new Error("Fixture embeddings are not ready")
  if (!(await projectWorkspaceGraph(revision)))
    throw new Error("Fixture graph is not ready")
  const { repository } = await createOrGetRepository({
    name: fixture.key,
    gitUrl: workspace.workspaceRepositoryUrl,
  })
  await ensureWorkspaceCheckout({
    repositoryId: repository.id,
    workspaceId: workspace.id,
    ref: revision.sha,
  })
  await indexRepository(
    {
      repositoryId: repository.id,
      orgId: org.id,
      workspaceId: workspace.id,
      workspaceRevisions: [{ repositoryId: repository.id, sha: revision.sha }],
    },
    revision.sha,
    workspaceCheckoutKey(workspace.id, revision.sha),
  )
  if (
    !(await persistWorkspaceIndexResult({
      revision,
      result: { kind: "ready" },
    }))
  )
    throw new Error("Fixture index changed before publication")
}

/**
 * Link each upstream repository through a GitHub source row, with the
 * manifest SHA as its ref, and pin it to that SHA. The fixtures have no
 * GitHub connection, so the seed writes the projection row itself.
 */
async function pinLinkedRepositories(input: {
  orgId: string
  workspaceId: string
  revisionSha: string
  upstreams: FixtureUpstream[]
}) {
  const { workspaceId, upstreams } = input
  await replaceWorkspaceSourceRows({
    orgId: input.orgId,
    workspaceId,
    revision: input.revisionSha,
    rows: upstreams.length
      ? [
          {
            sourceKey: "linked-repositories",
            provider: "github",
            connectionId: "con_mcp_eval",
            scope: {
              repositories: upstreams.map((upstream) => ({
                name: new URL(upstream.url).pathname.slice(1),
                ref: upstream.sha,
              })),
            },
            status: "ok",
            statusDetail: null,
          },
        ]
      : [],
  })
  for (const upstream of upstreams) {
    const link = (await listLinkedRepositories(workspaceId)).find(
      (link) => link.gitUrl === upstream.url,
    )
    const binding = link ? await getLinkedReadBinding(link.id) : null
    if (
      !binding ||
      !(await persistLinkedDesiredSha({
        binding,
        resolvedTip: upstream.sha,
      }))
    )
      throw new Error("Fixture link is absent")
    if (!(await persistLinkedIndexedSha({ ...binding, sha: upstream.sha })))
      throw new Error("Fixture link changed before publication")
  }
}

async function assertProjectionReady(workspaceId: string) {
  const projection = await getWorkspaceProjection(workspaceId)
  if (
    projection.kind !== "active" ||
    Object.values(projection.stores).some((store) => store.kind !== "ready")
  )
    throw new Error("Fixture projection is not ready")
}

function fixtureOrganizations(run: string) {
  return manifest.organizations.map((org) => ({
    id: `org_mcp_eval_${run}_${org.key}`,
    slug: `mcp-eval-${run}-${org.key}`,
    name: org.name,
    key: org.key,
  }))
}

async function readFixtureFiles(url: string, sha: string) {
  return listMarkdownFilesAtGitSha({
    url,
    sha,
    includeIntroducingCommits: true,
  })
}

export async function seedMcpEval(input: {
  run: string
  userId: string
  remotes: Record<string, string>
}) {
  const sources = new Map<
    string,
    {
      url: string
      tip: NonNullable<Awaited<ReturnType<typeof resolveGitRemoteTip>>>
      files: Awaited<ReturnType<typeof listMarkdownFilesAtGitSha>>
    }
  >()
  for (const fixture of manifest.workspaces) {
    const url = input.remotes[fixture.key]
    if (!url) throw new Error(`Missing fixture remote: ${fixture.key}`)
    const tip = await resolveGitRemoteTip({ url, branch: "main" })
    if (!tip) throw new Error(`Missing fixture branch: ${fixture.key}`)
    const files = await readFixtureFiles(url, tip.sha)
    const directory = new URL(`./fixtures/${fixture.key}/`, import.meta.url)
    const expected = (await readdir(directory, { recursive: true })).filter(
      (path) => path.endsWith(".md"),
    )
    const actual = new Map(files.map((file) => [file.path, file.content]))
    let matches = actual.size === expected.length
    for (const path of expected)
      if (
        actual.get(path) !== (await readFile(new URL(path, directory), "utf8"))
      )
        matches = false
    if (!matches)
      throw new Error(
        `Remote ${fixture.key} does not match the evaluation fixture`,
      )
    sources.set(fixture.key, { url, tip, files })
  }
  const orgs = fixtureOrganizations(input.run)
  await getSystemDb().transaction(async (tx) => {
    await tx.insert(organizations).values(
      orgs.map((org) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        createdAt: new Date(),
      })),
    )
    await tx.insert(members).values(
      orgs.map((org) => ({
        id: `member_mcp_eval_${input.run}_${org.key}`,
        organizationId: org.id,
        userId: input.userId,
        role: "owner",
        createdAt: new Date(),
      })),
    )
  })
  const seeded: Array<{
    key: string
    id: string
    orgId: string
    slug: string
    sha: string
  }> = []
  const indexed = new Map<string, string>()
  for (const fixture of manifest.workspaces) {
    const org = orgs.find((org) => org.key === fixture.organization)
    if (!org)
      throw new Error(`Missing fixture organization: ${fixture.organization}`)
    const source = sources.get(fixture.key)
    if (!source) throw new Error(`Missing fixture remote: ${fixture.key}`)
    const { url, tip, files } = source
    await withUserIdContext(input.userId, () =>
      withOrgIdContext(org, async () => {
        const workspace = await createWorkspace({
          gitUrl: url,
          slug: fixture.slug,
          displayName: fixture.name,
        })
        const revision = await captureWorkspaceRevision({
          workspaceId: workspace.id,
          expected: {
            generation: workspace.desiredGeneration,
            url: workspace.workspaceRepositoryUrl,
            sha: workspace.desiredSha,
            defaultBranch: workspace.desiredDefaultBranch ?? null,
            githubConnectionId: null,
          },
          tip,
        })
        if (!revision)
          throw new Error("Fixture revision changed before capture")
        await publishWorkspaceRevision({
          org,
          fixture,
          workspace,
          revision,
          files,
        })
        const upstreams = fixture.repositories.map((key) => {
          const upstream = manifest.upstreamRepositories.find(
            (repo) => repo.key === key,
          )
          if (!upstream) throw new Error(`Missing upstream pin: ${key}`)
          return upstream
        })
        for (const upstream of upstreams) {
          const cacheKey = `${org.id}/${upstream.key}`
          if (indexed.has(cacheKey)) continue
          const { repository } = await createOrGetRepository({
            name: new URL(upstream.url).pathname.slice(1),
            gitUrl: upstream.url,
          })
          await ensureRepositoryRevisionCheckout({
            orgId: org.id,
            repositoryId: repository.id,
            sha: upstream.sha,
          })
          await indexRepository(
            {
              repositoryId: repository.id,
              orgId: org.id,
              repositoryRevisions: [
                { repositoryId: repository.id, sha: upstream.sha },
              ],
            },
            upstream.sha,
            `rev:${upstream.sha}`,
          )
          await markRepositoryIndexingReady({
            repositoryId: repository.id,
            targetHash: upstream.sha,
          })
          indexed.set(cacheKey, repository.id)
        }
        await pinLinkedRepositories({
          orgId: org.id,
          workspaceId: workspace.id,
          revisionSha: revision.sha,
          upstreams,
        })
        await assertProjectionReady(workspace.id)
        seeded.push({
          key: fixture.key,
          id: workspace.id,
          orgId: org.id,
          slug: workspace.slug,
          sha: tip.sha,
        })
      }),
    )
  }
  return { organizations: orgs, workspaces: seeded }
}

/**
 * Move one seeded Workspace to the second projection, a new commit on the
 * fixture's `next` branch. A cursor from the first projection is stale after
 * this. The old projection SHA is `seeded.workspaces[n].sha`; the new one is
 * the return value.
 */
export async function advanceMcpEvalWorkspace(input: {
  run: string
  userId: string
  remotes: Record<string, string>
}): Promise<{ key: string; id: string; orgId: string; sha: string }> {
  const second = manifest.secondProjection
  const fixture = manifest.workspaces.find(
    (workspace) => workspace.key === second.workspace,
  )
  const org = fixtureOrganizations(input.run).find(
    (org) => org.key === fixture?.organization,
  )
  if (!fixture || !org) throw new Error("The second projection is not defined")
  const url = input.remotes[fixture.key]
  if (!url) throw new Error(`Missing fixture remote: ${fixture.key}`)
  const tip = await resolveGitRemoteTip({ url, branch: second.branch })
  if (!tip) throw new Error(`Missing second projection branch: ${fixture.key}`)
  const files = await readFixtureFiles(url, tip.sha)
  return withUserIdContext(input.userId, () =>
    withOrgIdContext(org, async () => {
      const workspace = await getWorkspaceBySlug(fixture.slug)
      if (!workspace) throw new Error("The Workspace was not seeded")
      const current = await getDesiredWorkspaceRevision(workspace.id)
      if (!current) throw new Error("The Workspace has no desired revision")
      // The Workspace stays on `main`; only its SHA moves.
      const revision = await captureWorkspaceRevision({
        workspaceId: workspace.id,
        expected: {
          generation: current.generation,
          url: current.remote.url,
          sha: current.sha,
          defaultBranch: current.defaultBranch,
          githubConnectionId: current.remote.connectionId,
        },
        tip: { sha: tip.sha, branch: current.defaultBranch },
      })
      if (!revision) throw new Error("Fixture revision changed before capture")
      await publishWorkspaceRevision({
        org,
        fixture,
        workspace,
        revision,
        files,
      })
      await pinLinkedRepositories({
        orgId: org.id,
        workspaceId: workspace.id,
        revisionSha: revision.sha,
        upstreams: fixture.repositories.map((key) => {
          const upstream = manifest.upstreamRepositories.find(
            (repo) => repo.key === key,
          )
          if (!upstream) throw new Error(`Missing upstream pin: ${key}`)
          return upstream
        }),
      })
      await assertProjectionReady(workspace.id)
      return { key: fixture.key, id: workspace.id, orgId: org.id, sha: tip.sha }
    }),
  )
}

/**
 * Create a personal API key for the evaluation user, limited to the fixture
 * organizations. A key with an empty org set reaches every membership, so an
 * empty list is refused. The caller keeps the key secret.
 */
export async function createMcpEvalApiKey(input: {
  userId: string
  organizationIds: string[]
}): Promise<{ id: string; key: string }> {
  if (input.organizationIds.length === 0)
    throw new Error("The evaluation key needs at least one organization")
  const created = await getAuth().api.createApiKey({
    body: { userId: input.userId, name: "mcp-eval" },
  })
  if (!created?.key) throw new Error("createApiKey did not return a key")
  await setOrganizations({ apiKeyId: created.id }, input.organizationIds)
  return { id: created.id, key: created.key }
}
