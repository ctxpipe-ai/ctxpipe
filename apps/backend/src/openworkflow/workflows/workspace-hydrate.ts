import { z } from "zod"
import { withOrgIdContext } from "../../auth/withAuth.js"
import { parseEnv } from "../../config/env.js"
import { getSystemDb, withOrgDbContext } from "../../db/client.js"
import { githubSourceRepositories } from "../../domain/workspace-sources/github-sources.js"
import { projectWorkspaceSources } from "../../domain/workspace-sources/project.js"
import type { SourceFileBlob } from "../../domain/workspace-sources/projection-plan.js"
import {
  SOURCES_TREE_READ,
  splitSourcesTree,
} from "../../domain/workspace-sources/source-tree.js"
import { nativeFolderSetChanged } from "../../domain/workspaces/folder-list.js"
import { projectWorkspaceGraph } from "../../domain/workspaces/graph-projection.js"
import {
  applyEffectiveValidFromToUnits,
  displayNameFromAgentsMarkdown,
  hydrateKnowledgeTree,
  LEGACY_UNIT_SOURCE,
} from "../../domain/workspaces/hydrate.js"
import { planHydrateWrites } from "../../domain/workspaces/hydrate-write-planner.js"
import {
  legacyKnowledgeOverlay,
  legacyKnowledgeOverlayScope,
} from "../../domain/workspaces/legacy-knowledge-overlay.js"
import { upgradeLinkedRepositories } from "../../domain/workspaces/migration-export.js"
import { nativeRenameRewriteFiles } from "../../domain/workspaces/native-rename-rewrite.js"
import {
  resolveRepositoryReadCredential,
  resolveWorkspaceReadRevision,
} from "../../domain/workspaces/resolve-revision.js"
import {
  linkedRevisionSchema,
  publishedProjection,
  sameWorkspaceRevision,
  type WorkspaceRevision,
  workspaceRevisionSchema,
} from "../../domain/workspaces/revision.js"
import { workspaceRootPath } from "../../domain/workspaces/root-path.js"
import { normalizeWorkspaceRepositoryUrl } from "../../domain/workspaces/slug.js"
import {
  formatChangeNeedsScan,
  readWorkspaceFormat,
  WORKSPACE_FORMAT_PATH,
  workspaceFormatCache,
  workspaceFormatCacheValue,
} from "../../domain/workspaces/workspace-format.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../../domain/workspaces/write-status.js"
import { listOrgConnections } from "../../models/org-connections.js"
import {
  loadKnowledgeProjectionSource,
  reingestedRepositories,
} from "../../models/workspace-export.js"
import { listWorkspaceSourceRows } from "../../models/workspace-sources.js"
import { reserveHydrateWrites } from "../../models/workspace-write-planning.js"
import {
  commitHydrateProjection,
  embedKnowledgeChunks,
  getLinkedReadBinding,
  getWorkspaceProjectionSnapshot,
  listLinkedRepositories,
  markKnowledgeEmbeddingsReady,
  persistEmbeddingFailure,
  persistHydrateFailure,
  persistWorkspaceGraphResult,
} from "../../models/workspaces.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import {
  embeddingModelId,
  generateEmbeddings,
} from "../../retrieval/services/modelProvider.js"
import { listMarkdownFilesAtGitSha } from "../../services/git/clone-tree.js"
import { readGitFiles, readGitPackFromRemote } from "../../services/git/pack.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWorkspaceIndex } from "../enqueue-workspace-index.js"

const workspaceHydrateInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    revision: workspaceRevisionSchema,
    /**
     * Project the revision again, also when it is the active one. A
     * re-ingestion sets it when it did a repository, so that the main-era
     * knowledge of that repository leaves the projection.
     */
    reproject: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (input) => input.revision.workspaceId === input.workspaceId,
    "A bound hydrate input must contain its matching revision",
  )

async function enqueueLaggingIndex(input: {
  orgId: string
  revision: WorkspaceRevision
}): Promise<void> {
  const linked = await withOrgDbContext(input.orgId, () =>
    listLinkedRepositories(input.revision.workspaceId),
  )
  const log = getLogger()
  await enqueueWorkspaceIndex(
    { orgId: input.orgId, revision: input.revision },
    { error: (err) => log.error(err) },
  )
  for (const row of linked) {
    if (!row.desiredSha || row.desiredSha === row.indexedSha) continue
    const binding = await withOrgDbContext(input.orgId, () =>
      getLinkedReadBinding(row.id),
    )
    if (!binding?.sha || !sameWorkspaceRevision(binding.owner, input.revision))
      continue
    await enqueueWorkspaceIndex(
      {
        orgId: input.orgId,
        revision: input.revision,
        linked: linkedRevisionSchema.parse(binding),
      },
      { error: (err) => log.error(err) },
    )
  }
}

export function defineWorkspaceHydrateWorkflow() {
  return defineWorkflow(
    {
      name: "workspace-hydrate",
      schema: workspaceHydrateInputSchema,
      // The body reads git outside a step. Retry it like a step.
      retryPolicy: {
        initialInterval: "1s",
        backoffCoefficient: 2,
        maximumInterval: "100s",
        maximumAttempts: 10,
      },
    },
    async ({ input: queuedInput, step }) => {
      // OpenWorkflow validates enqueue, but persisted pre-upgrade runs reach the worker directly.
      const parsedInput = workspaceHydrateInputSchema.safeParse({
        orgId: queuedInput.orgId,
        workspaceId: queuedInput.workspaceId,
        revision: queuedInput.revision,
        ...(queuedInput.reproject ? { reproject: queuedInput.reproject } : {}),
      })
      if (!parsedInput.success) {
        // A retry cannot repair the input. A failed step without retries ends
        // the run now, before the workflow retry policy applies.
        await step.run(
          { name: "reject-input", retryPolicy: { maximumAttempts: 1 } },
          () => {
            throw parsedInput.error
          },
        )
        throw parsedInput.error
      }
      const input = parsedInput.data
      return withLogger(
        createLogger({
          workflow: "workspace-hydrate",
          orgId: input.orgId,
          workspaceId: input.workspaceId,
        }),
        async () => {
          const env = parseEnv(
            process.env as Record<string, string | undefined>,
          )
          const org = await getSystemDb().query.organizations.findFirst({
            where: { id: { eq: input.orgId } },
          })
          if (!org) throw new Error(`Organization not found: ${input.orgId}`)

          return withOrgIdContext({ id: org.id, slug: org.slug }, async () => {
            const orgSql = <T>(fn: () => Promise<T>) =>
              withOrgDbContext(input.orgId, fn)
            let failingRevision: WorkspaceRevision | undefined = input.revision
            try {
              const resolved = await resolveWorkspaceReadRevision({
                orgId: input.orgId,
                workspaceId: input.workspaceId,
                env,
                expected: input.revision,
              })
              if (!resolved)
                return { hydrated: false, reason: "cas_discarded" as const }
              const { revision, token, workspace } = resolved
              failingRevision = revision
              const desiredSha = revision.sha
              const snapshot = await getWorkspaceProjectionSnapshot(
                workspace.id,
              )
              const projection = publishedProjection(snapshot.projection)
              // A projection made before knowledge chunks existed is
              // published again, once, so that it gets its chunks.
              const active =
                projection?.kind === "active" &&
                sameWorkspaceRevision(projection.revision, revision) &&
                !snapshot.chunksMissing &&
                !input.reproject
                  ? projection
                  : null
              const pending = {
                postgres: !active,
                embeddings:
                  !active || active.stores.embeddings.kind !== "ready",
                index: !active || active.stores.index.kind !== "ready",
                graph: !active || active.stores.graph.kind !== "ready",
              }
              const planning = await step.run(
                { name: "capture-planning-target" },
                async () => ({
                  // An upgrade pull request always makes a new SHA, so the
                  // writes that a format change needs come with that SHA.
                  needed: pending.postgres,
                  previousSha:
                    projection?.kind === "active" &&
                    sameWorkspaceRevision(
                      { ...projection.revision, sha: revision.sha },
                      revision,
                    )
                      ? projection.revision.sha
                      : null,
                }),
              )
              // Not a step: OpenWorkflow keeps a step output in one jsonb value
              // and loads all outputs on each replay. The tree at a fixed SHA
              // does not change. Read it only when a write plan or the
              // projection needs it, so a replay after both does not fetch.
              let tree:
                | Promise<{
                    files: Awaited<ReturnType<typeof listMarkdownFilesAtGitSha>>
                    sourcesFile: string | null
                    sourceFiles: SourceFileBlob[]
                    formatFile: string | null
                    treePaths: Set<string>
                    deletedPaths: Set<string>
                  }>
                | undefined
              const readTree = () => {
                tree ??= (async () => {
                  const deletedPaths = new Set<string>()
                  const treeFiles = planning.needed
                    ? await listMarkdownFilesAtGitSha({
                        includeIntroducingCommits: true,
                        deletedPaths,
                        // An upgrade or its revert moves files: its deletes
                        // are not deletes of a person.
                        layoutPath: WORKSPACE_FORMAT_PATH,
                        ...SOURCES_TREE_READ,
                        extraPaths: [
                          ...SOURCES_TREE_READ.extraPaths,
                          WORKSPACE_FORMAT_PATH,
                        ],
                        url: revision.remote.url,
                        sha: revision.sha,
                        root: workspaceRootPath(revision),
                        token:
                          token ??
                          (await resolveRepositoryReadCredential({
                            orgId: input.orgId,
                            env,
                            remote: revision.remote,
                          })),
                      })
                    : []
                  return {
                    ...splitSourcesTree(treeFiles),
                    treePaths: new Set(treeFiles.map((file) => file.path)),
                    deletedPaths,
                    formatFile:
                      treeFiles.find(
                        (file) => file.path === WORKSPACE_FORMAT_PATH,
                      )?.content ?? null,
                  }
                })()
                return tree
              }
              const enqueueRemainingWrites = async () => {
                if (!planning.needed) return
                const plan = await step.run(
                  { name: "plan-remaining-writes" },
                  async () => {
                    const { files, sourceFiles, formatFile } = await readTree()
                    return planHydrateWrites({
                      revision,
                      displayName: workspace.displayName,
                      files,
                      sourceFiles,
                      sourceRows: await listWorkspaceSourceRows({
                        orgId: input.orgId,
                        workspaceId: workspace.id,
                      }),
                      format: workspaceFormatCacheValue(
                        readWorkspaceFormat(formatFile),
                      ),
                      history: async () => {
                        const previousSha = planning.previousSha
                        if (!previousSha || previousSha === revision.sha)
                          return null
                        const pack = await readGitPackFromRemote({
                          url: revision.remote.url,
                          sha: revision.sha,
                          additionalShas: [previousSha],
                          root: workspaceRootPath(revision),
                          token:
                            token ??
                            (await resolveRepositoryReadCredential({
                              orgId: input.orgId,
                              env,
                              remote: revision.remote,
                            })),
                        })
                        const [previousFormatFile] = await readGitFiles(
                          { ...pack, sha: previousSha },
                          (path) => path === WORKSPACE_FORMAT_PATH,
                        )
                        return {
                          previousSha,
                          previousFormat: workspaceFormatCacheValue(
                            readWorkspaceFormat(
                              previousFormatFile?.content ?? null,
                            ),
                          ),
                          renameRewrites: (
                            await nativeRenameRewriteFiles(pack, previousSha)
                          ).length,
                          folderSetChanged: await nativeFolderSetChanged(
                            pack,
                            previousSha,
                          ),
                        }
                      },
                    })
                  },
                )
                // Import at the admission boundary: typed writers themselves enqueue hydrate.
                const { enqueueWriteJob } = await import(
                  "../enqueue-workspace-write-commit.js"
                )
                const reserved = await step.run(
                  { name: "reserve-remaining-writes" },
                  () => reserveHydrateWrites({ revision, remaining: plan }),
                )
                for (const command of reserved) {
                  await step.run(
                    { name: `admit-${command.kind}` },
                    async () => {
                      await enqueueWriteJob(
                        {
                          orgId: input.orgId,
                          workspaceId: revision.workspaceId,
                          jobId: command.jobId,
                          kind: command.kind,
                          previousSha: command.previousSha,
                          jobGeneration: revision.generation,
                          jobWorkspaceUrl: revision.remote.url,
                          jobDesiredSha: revision.sha,
                          defaultBranch: revision.defaultBranch,
                        },
                        {
                          error: (error) => {
                            throw error
                          },
                        },
                      )
                    },
                  )
                }
              }
              if (
                !pending.postgres &&
                !pending.embeddings &&
                !pending.index &&
                !pending.graph
              ) {
                await enqueueRemainingWrites()
                return { hydrated: false, reason: "noop" as const }
              }
              if (
                pending.index &&
                !pending.postgres &&
                !pending.embeddings &&
                !pending.graph
              ) {
                await enqueueLaggingIndex({
                  orgId: input.orgId,
                  revision,
                })
                await enqueueRemainingWrites()
                return { hydrated: false, reason: "index_lag" as const }
              }

              // A GitHub source links its repositories only with a GitHub
              // connection of this org.
              const githubConnectionIds = pending.postgres
                ? await step.run(
                    { name: "list-github-connections" },
                    async () =>
                      (await listOrgConnections(input.orgId))
                        .filter((connection) => connection.type === "github")
                        .map((connection) => connection.id),
                  )
                : []
              const {
                files,
                sourcesFile,
                sourceFiles,
                formatFile,
                treePaths,
                deletedPaths,
              } = pending.postgres
                ? await readTree()
                : {
                    files: [],
                    sourcesFile: null,
                    sourceFiles: [],
                    formatFile: null,
                    treePaths: new Set<string>(),
                    deletedPaths: new Set<string>(),
                  }
              // A Confluence URL joins a mirrored page only on the org's site.
              const confluenceSiteHosts = pending.postgres
                ? await step.run({ name: "list-confluence-sites" }, async () =>
                    // A Confluence connection's display name is its site host.
                    (await listOrgConnections(input.orgId))
                      .filter((connection) => connection.type === "forge")
                      .flatMap((connection) => connection.displayName ?? []),
                  )
                : []
              // The projection decides the winner of a repository that two
              // sources name from these rows; the linked set uses the same rule.
              const previousSourceRows = pending.postgres
                ? await step.run(
                    { name: "list-previous-source-rows" },
                    async () =>
                      (
                        await listWorkspaceSourceRows({
                          orgId: input.orgId,
                          workspaceId: workspace.id,
                        })
                      ).map((row) => ({
                        sourceKey: row.sourceKey,
                        provider: row.provider,
                        connectionId: row.connectionId,
                        scope: row.scope,
                        status: row.status,
                        state: row.state,
                      })),
                  )
                : []
              // The main-era knowledge in Postgres joins the projection as
              // read-only files that are not in git: below format 3 all of
              // it, and at format 3 or more that of each GitHub source
              // repository that no re-ingestion did yet. Not a step: the rows
              // do not change, and a step output would hold all of them.
              const overlayScope = pending.postgres
                ? legacyKnowledgeOverlayScope(
                    workspaceFormatCacheValue(readWorkspaceFormat(formatFile)),
                  )
                : null
              // A repository that a re-ingestion did gets no overlay at any
              // scope: a revert of the upgrade must not show it twice.
              const done = overlayScope
                ? await reingestedRepositories(workspace.id)
                : new Set<string>()
              let onlyRepositoryUrls: Set<string> | undefined
              if (overlayScope === "sources") {
                onlyRepositoryUrls = new Set(
                  githubSourceRepositories(sourcesFile, null, sourceFiles, {
                    previousRows: previousSourceRows,
                    workspaceUrl: revision.remote.url,
                  }).flatMap((source) => {
                    const url = normalizeWorkspaceRepositoryUrl(source.gitUrl)
                    const name = githubRepoFullNameFromWorkspaceUrl(url)
                    return name && !done.has(name.toLowerCase()) ? [url] : []
                  }),
                )
              }
              const legacyFiles =
                overlayScope && (!onlyRepositoryUrls || onlyRepositoryUrls.size)
                  ? await legacyKnowledgeOverlay({
                      workspaceId: workspace.id,
                      workspaceRepositoryUrl: revision.remote.url,
                      treePaths,
                      deletedPaths,
                      files,
                      onlyRepositoryUrls,
                      reingestedRepositories: done,
                      source: await loadKnowledgeProjectionSource({
                        workspaceId: workspace.id,
                      }),
                    })
                  : []
              const legacyPaths = new Set(legacyFiles.map((file) => file.path))
              const parsed = pending.postgres
                ? hydrateKnowledgeTree({
                    workspaceId: workspace.id,
                    workspaceUrl: revision.remote.url,
                    files: [...files, ...legacyFiles],
                    sourcesFile,
                    sourceFiles,
                    previousSourceRows,
                    githubConnectionIds: new Set(githubConnectionIds),
                    confluenceSiteHosts: new Set(confluenceSiteHosts),
                  })
                : { units: snapshot.units, linked: [], skipped: [] }
              if (legacyPaths.size)
                for (const unit of parsed.units)
                  if (legacyPaths.has(unit.path))
                    unit.source = LEGACY_UNIT_SOURCE
              const agents = files.find((file) => file.path === "AGENTS.md")
              const displayName = agents
                ? displayNameFromAgentsMarkdown(agents.content)
                : null
              const log = getLogger()
              log.set({
                workspaceId: workspace.id,
                desiredSha,
              })

              let activated = !pending.postgres
              if (pending.postgres) {
                // Before the sources projection changes the pinned state, so a
                // replay still sees which GitHub links are new and the backfill
                // key dedupes the enqueue.
                await step.run(
                  { name: "enqueue-github-pr-backfills" },
                  async () => {
                    // Import at the admission boundary: the mirror enqueues hydrate.
                    const { enqueueGithubPrBackfillsForNewLinks } =
                      await import("./github-sync-pull-request.js")
                    await enqueueGithubPrBackfillsForNewLinks({
                      orgId: input.orgId,
                      workspaceId: workspace.id,
                      workspaceUrl: revision.remote.url,
                      gitUrls: parsed.linked.map((remote) => remote.git),
                    })
                  },
                )
                const formatVersion = workspaceFormatCache({
                  text: formatFile,
                  paths: treePaths,
                  writeStatus: workspace.writeStatus,
                })
                activated = await orgSql(() =>
                  commitHydrateProjection({
                    orgId: input.orgId,
                    revision,
                    displayName,
                    formatVersion,
                    skipped: parsed.skipped,
                    embeddingModel: embeddingModelId(),
                    units: applyEffectiveValidFromToUnits(
                      parsed.units,
                      new Map(
                        files.flatMap((file) =>
                          file.introducingCommitTimestamp
                            ? [
                                [
                                  file.path,
                                  file.introducingCommitTimestamp,
                                ] as const,
                              ]
                            : [],
                        ),
                      ),
                    ),
                  }),
                )
                if (!activated) {
                  return {
                    hydrated: false,
                    reason: "cas_discarded" as const,
                    units: parsed.units.length,
                    skipped: parsed.skipped.length,
                  }
                }
                // A new format can complete an upgrade, and it can lift or
                // set the format gate. The scan records the upgrade state,
                // and its tip check resumes the write jobs that the gate held.
                if (
                  formatChangeNeedsScan(workspace.formatVersion, formatVersion)
                )
                  await step.run({ name: "enqueue-upgrade-scan" }, async () => {
                    // Import at the admission boundary, like the PR backfill above.
                    const { enqueueWorkspaceUpgradeScan } = await import(
                      "./workspace-upgrade-scan.js"
                    )
                    await enqueueWorkspaceUpgradeScan({
                      orgId: input.orgId,
                      trigger: `format:${workspace.id}:${revision.sha}`,
                    })
                  })
              }

              if (activated && pending.postgres && planning.needed) {
                // Two steps: a retry of the follow-ups reuses the memoized
                // diff, because a second projection of the same revision finds
                // no diff.
                const projected = await step.run(
                  { name: "project-workspace-sources" },
                  () =>
                    projectWorkspaceSources({
                      orgId: input.orgId,
                      workspaceId: workspace.id,
                      revision: revision.sha,
                      text: sourcesFile,
                      files: sourceFiles,
                      leftoverFiles: revision.remote.connectionId
                        ? upgradeLinkedRepositories({
                            sourcesFile,
                            connectionId: revision.remote.connectionId,
                            files,
                          }).skipped.map(({ item, reason }) => ({
                            path: item,
                            reason,
                          }))
                        : [],
                      env,
                    }),
                )
                await step.run(
                  { name: "enqueue-source-follow-ups" },
                  async () => {
                    // Import at the admission boundary, like the PR backfill above.
                    const { enqueueSourceProjectionFollowUps } = await import(
                      "../../domain/workspace-sources/enqueue.js"
                    )
                    await enqueueSourceProjectionFollowUps({
                      orgId: input.orgId,
                      workspaceId: workspace.id,
                      revision: revision.sha,
                      projected,
                      format: workspaceFormatCacheValue(
                        readWorkspaceFormat(formatFile),
                      ),
                    })
                  },
                )
              }

              if (activated && pending.graph) {
                try {
                  await projectWorkspaceGraph(revision)
                } catch (error) {
                  log.error(
                    error instanceof Error ? error : new Error(String(error)),
                  )
                  // A step so that a failed write retries and the graph phase leaves `pending`.
                  await step.run({ name: "persist-graph-failure" }, () =>
                    persistWorkspaceGraphResult({
                      revision,
                      result: {
                        kind: "failed",
                        message:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      },
                    }),
                  )
                }
              }

              if (activated && pending.embeddings) {
                try {
                  await embedKnowledgeChunks({
                    workspaceId: workspace.id,
                    embed: generateEmbeddings,
                  })
                  await markKnowledgeEmbeddingsReady({ revision })
                } catch (error) {
                  log.error(
                    error instanceof Error
                      ? error
                      : new Error("hydrate embeddings failed"),
                  )
                  await persistEmbeddingFailure({
                    revision,
                    message:
                      error instanceof Error ? error.message : String(error),
                  })
                }
              }

              if (pending.index) {
                await enqueueLaggingIndex({
                  orgId: input.orgId,
                  revision,
                })
              }

              await enqueueRemainingWrites()
              return {
                hydrated: activated,
                units: parsed.units.length,
                skipped: parsed.skipped.length,
                diagnostics: parsed.skipped,
              }
            } catch (error) {
              try {
                if (failingRevision)
                  await orgSql(() =>
                    persistHydrateFailure({
                      revision: failingRevision as WorkspaceRevision,
                      message:
                        error instanceof Error ? error.message : String(error),
                    }),
                  )
              } catch {
                // Persist is best-effort; OpenWorkflow still records the failed run.
              }
              throw error
            }
          })
        },
      )
    },
  )
}

export const workspaceHydrate = defineWorkspaceHydrateWorkflow()
