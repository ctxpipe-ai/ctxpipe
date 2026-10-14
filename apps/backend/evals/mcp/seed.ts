import { execFileSync } from "node:child_process"
import { cp, mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { withUserIdContext } from "../../src/auth/context.js"
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
import {
  captureWorkspaceRevision,
  commitHydrateProjection,
  createWorkspace,
  embedKnowledgeChunks,
  getLinkedReadBinding,
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
import manifest from "./fixtures/manifest.json"

export { manifest as mcpEvalManifest }

/** Create immutable fixture repositories; the caller owns their lifetime. */
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
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: checkout,
        stdio: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: manifest.commitDate,
          GIT_COMMITTER_DATE: manifest.commitDate,
        },
      })
    git("init", "--initial-branch=main", "--object-format=sha1", "--template=")
    git("-c", "core.autocrlf=false", "add", ".")
    git(
      "-c",
      "user.name=MCP Eval",
      "-c",
      "user.email=mcp-eval@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Seed synthetic MCP context",
    )
    git("clone", "--bare", checkout, remote)
    remotes[workspace.key] = pathToFileURL(remote).href
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

export async function seedMcpEval(input: {
  run: string
  userId: string
  remotes: Record<string, string>
}) {
  const sources = new Map<
    string,
    {
      tip: NonNullable<Awaited<ReturnType<typeof resolveGitRemoteTip>>>
      files: Awaited<ReturnType<typeof listMarkdownFilesAtGitSha>>
    }
  >()
  for (const fixture of manifest.workspaces) {
    const url = input.remotes[fixture.key]
    if (!url) throw new Error(`Missing fixture remote: ${fixture.key}`)
    const tip = await resolveGitRemoteTip({ url, branch: "main" })
    if (!tip) throw new Error(`Missing fixture branch: ${fixture.key}`)
    const files = await listMarkdownFilesAtGitSha({
      url,
      sha: tip.sha,
      includeIntroducingCommits: true,
    })
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
    sources.set(fixture.key, { tip, files })
  }
  const orgs = manifest.organizations.map((org) => ({
    id: `org_mcp_eval_${input.run}_${org.key}`,
    slug: `mcp-eval-${input.run}-${org.key}`,
    name: org.name,
    key: org.key,
  }))
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
    id: string
    orgId: string
    slug: string
    sha: string
  }> = []
  const indexed = new Map<string, string>()
  for (const fixture of manifest.workspaces) {
    const org = orgs.find((org) => org.key === fixture.organization)
    const url = input.remotes[fixture.key]
    const source = sources.get(fixture.key)
    if (!org || !url || !source)
      throw new Error(`Missing fixture remote: ${fixture.key}`)
    const { tip, files } = source
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
        const parsed = hydrateKnowledgeTree({
          workspaceId: workspace.id,
          workspaceUrl: url,
          files,
        })
        if (parsed.skipped.length)
          throw new Error("Fixture contains invalid Markdown")
        if (
          !(await commitHydrateProjection({
            orgId: org.id,
            revision,
            displayName: fixture.name,
            remotes: parsed.linked,
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
          ref: tip.sha,
        })
        await indexRepository(
          {
            repositoryId: repository.id,
            orgId: org.id,
            workspaceId: workspace.id,
            workspaceRevisions: [{ repositoryId: repository.id, sha: tip.sha }],
          },
          tip.sha,
          workspaceCheckoutKey(workspace.id, tip.sha),
        )
        if (
          !(await persistWorkspaceIndexResult({
            revision,
            result: { kind: "ready" },
          }))
        )
          throw new Error("Fixture index changed before publication")
        for (const key of fixture.repositories) {
          const upstream = manifest.upstreamRepositories.find(
            (repo) => repo.key === key,
          )
          if (!upstream) throw new Error(`Missing upstream pin: ${key}`)
          const cacheKey = `${org.id}/${key}`
          let repositoryId = indexed.get(cacheKey)
          if (!repositoryId) {
            const { repository } = await createOrGetRepository({
              name: `sindresorhus/${key}`,
              gitUrl: upstream.url,
            })
            repositoryId = repository.id
            await ensureRepositoryRevisionCheckout({
              orgId: org.id,
              repositoryId,
              sha: upstream.sha,
            })
            await indexRepository(
              {
                repositoryId,
                orgId: org.id,
                repositoryRevisions: [{ repositoryId, sha: upstream.sha }],
              },
              upstream.sha,
              `rev:${upstream.sha}`,
            )
            await markRepositoryIndexingReady({
              repositoryId,
              targetHash: upstream.sha,
            })
            indexed.set(cacheKey, repositoryId)
          }
          const link = (await listLinkedRepositories(workspace.id)).find(
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
          if (
            !(await persistLinkedIndexedSha({ ...binding, sha: upstream.sha }))
          )
            throw new Error("Fixture link changed before publication")
        }
        const projection = await getWorkspaceProjection(workspace.id)
        if (
          projection.kind !== "active" ||
          Object.values(projection.stores).some(
            (store) => store.kind !== "ready",
          )
        )
          throw new Error("Fixture projection is not ready")
        seeded.push({
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
