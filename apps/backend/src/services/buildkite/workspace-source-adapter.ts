import type { Env } from "../../config/env.js"
import type { SourceAdapter } from "../../domain/workspace-sources/adapter.js"
import type { BuildkiteSourceScope } from "../../domain/workspace-sources/providers/buildkite.js"
import { countSourceFailure } from "../../lib/connection-config.js"
import {
  type BuildkiteConnection,
  getBuildkiteConnection,
  getBuildkiteConnectionStatus,
  markBuildkiteConnectionRevoked,
} from "../../models/buildkite-connector.js"
import { saveConnectionSourceSync } from "../../models/connection-source-sync.js"
import { log } from "../../observability/logger.js"
import { connectorCommitFileUnchanged } from "../connectors/assets.js"
import type { GitFileChange } from "../git/file-change.js"
import {
  BuildkiteUnauthorizedError,
  getBuildkitePipeline,
  listBuildkiteBuilds,
} from "./client.js"
import { buildkitePipelineFiles, buildkitePipelineRoot } from "./converter.js"

/**
 * A pipeline that is gone or out of reach (404 or 403) in this many sync
 * cycles goes out of access. Before that, the Workspace keeps its last copy.
 */
export const BUILDKITE_SYNC_MAX_TRIES = 3

/** The text that a source of a revoked Buildkite connection shows. */
const RECONNECT_DETAIL =
  "Buildkite does not accept the API access token of this connection any more. Reconnect Buildkite on the Connectors page."

const failureKey = (pipelineSlug: string) => `pipeline:${pipelineSlug}`

function missingDetail(
  pipelineSlug: string,
  reason: "not_found" | "forbidden",
) {
  return reason === "not_found"
    ? `Buildkite pipeline ${pipelineSlug} does not exist. Remove it from the source.`
    : `ctx| cannot read Buildkite pipeline ${pipelineSlug}. Give the API access token access to it, or remove it from the source.`
}

async function loadConnection(
  orgId: string,
  connectionId: string,
  env: Env,
): Promise<BuildkiteConnection> {
  const connection = await getBuildkiteConnection(orgId, connectionId, env)
  if (!connection) throw new Error("The Buildkite connection does not exist")
  return connection
}

function markRevoked(connection: BuildkiteConnection) {
  return markBuildkiteConnectionRevoked({
    orgId: connection.orgId,
    connectionId: connection.id,
    apiTokenEnc: connection.apiTokenEnc,
  })
}

function withoutUnchanged(
  files: GitFileChange[],
  existing: ReadonlyArray<{ path: string; sha: string | null }>,
): GitFileChange[] {
  const shas = new Map(
    existing.flatMap((file) =>
      file.sha ? [[file.path, file.sha] as const] : [],
    ),
  )
  return files.filter((file) => !connectorCommitFileUnchanged(file, shas))
}

/**
 * The Buildkite adapter of the Workspace sources sync (ADR-054). Each sync
 * reads each pipeline and its latest finished builds (two requests for each
 * pipeline), and writes them under `buildkite/pipelines/<slug>/`. A build
 * that is no longer among the latest goes away in the same commit.
 */
export const buildkiteSourceAdapter: SourceAdapter<BuildkiteSourceScope> = {
  provider: "buildkite",
  managedPaths: (scope) => scope.pipelines.map(buildkitePipelineRoot),
  async fetch({ orgId, connectionId, scopes, env, existing, countFailures }) {
    const slugs = [...new Set(scopes.flatMap((scope) => scope.pipelines))]
    const roots = slugs.map(buildkitePipelineRoot)
    const connection = await loadConnection(orgId, connectionId, env)
    // A revoked connection keeps every file until a reconnect.
    if (connection.status === "revoked") return { files: [], keepPaths: roots }

    const failures = { ...connection.sourceSync?.failures }
    const files: GitFileChange[] = []
    const deletePaths: string[] = []
    const keepPaths: string[] = []
    const unreachable: Array<{
      path: string
      status: "out_of_access"
      detail: string
    }> = []
    const now = new Date()
    let revoked = false
    for (const pipelineSlug of slugs) {
      const root = buildkitePipelineRoot(pipelineSlug)
      if (revoked) {
        keepPaths.push(root)
        continue
      }
      const request = {
        apiToken: connection.apiToken,
        organizationSlug: connection.organizationSlug,
        pipelineSlug,
      }
      try {
        const pipeline = await getBuildkitePipeline(request)
        if (pipeline === "not_found" || pipeline === "forbidden") {
          keepPaths.push(root)
          const counted = countSourceFailure({
            count: countFailures,
            failures,
            key: failureKey(pipelineSlug),
            now,
            detail: (tries) =>
              `${missingDetail(pipelineSlug, pipeline)} (${tries} failed syncs)`,
          })
          if (counted && counted.tries >= BUILDKITE_SYNC_MAX_TRIES)
            unreachable.push({
              path: root,
              status: "out_of_access",
              detail: counted.detail,
            })
          continue
        }
        const pipelineFiles = buildkitePipelineFiles({
          organizationSlug: connection.organizationSlug,
          pipeline,
          builds: await listBuildkiteBuilds(request),
        })
        delete failures[failureKey(pipelineSlug)]
        // A patch: the changed files, and the builds that rolled off.
        const desired = new Set(pipelineFiles.map((file) => file.path))
        files.push(...withoutUnchanged(pipelineFiles, existing ?? []))
        deletePaths.push(
          ...(existing ?? [])
            .map((file) => file.path)
            .filter((path) => path.startsWith(root) && !desired.has(path)),
        )
      } catch (error) {
        keepPaths.push(root)
        if (error instanceof BuildkiteUnauthorizedError) {
          revoked = true
          await markRevoked(connection)
          continue
        }
        // A provider outage: keep the last copy, and do not count it.
        log.warn({
          step: "buildkite.sources.capture",
          connectionId,
          pipelineSlug,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    // A full sync sees every pipeline, so it drops the counts of removed ones.
    await saveConnectionSourceSync({
      type: "buildkite",
      orgId,
      connectionId,
      sourceSync: {
        failures: Object.fromEntries(
          Object.entries(failures).filter(([key]) =>
            slugs.some((slug) => failureKey(slug) === key),
          ),
        ),
      },
    })
    const kept = keepPaths.filter(
      (path) => !unreachable.some((lost) => lost.path === path),
    )
    return { files, deletePaths, keepPaths: kept, unreachable }
  },
  async checkAccess({ orgId, connectionId, scope, env }) {
    const connection = await loadConnection(orgId, connectionId, env)
    if (connection.status === "revoked") return RECONNECT_DETAIL
    const problems: string[] = []
    for (const pipelineSlug of scope.pipelines) {
      try {
        const pipeline = await getBuildkitePipeline({
          apiToken: connection.apiToken,
          organizationSlug: connection.organizationSlug,
          pipelineSlug,
        })
        if (pipeline === "not_found" || pipeline === "forbidden")
          problems.push(missingDetail(pipelineSlug, pipeline))
      } catch (error) {
        if (error instanceof BuildkiteUnauthorizedError) {
          await markRevoked(connection)
          return RECONNECT_DETAIL
        }
        // During an outage, a failure that the sync recorded still shows.
        const recorded =
          connection.sourceSync?.failures[failureKey(pipelineSlug)]
        if (recorded && recorded.tries >= BUILDKITE_SYNC_MAX_TRIES)
          problems.push(recorded.detail)
      }
    }
    return problems.length ? problems.join("; ") : null
  },
  async syncStatus({ orgId, connectionId }) {
    return (await getBuildkiteConnectionStatus(orgId, connectionId)) ===
      "revoked"
      ? { status: "out_of_access" as const, detail: RECONNECT_DETAIL }
      : null
  },
}
