import { eq } from "drizzle-orm"
import { withOrgDbContext } from "../db/client.js"
import { repositories } from "../db/schema/repositories.js"
import type {
  IngestionV2Input,
  IngestSource,
} from "../domain/ingestion/ingestion-run.js"
import { resolveIngestionV2Run } from "../domain/ingestion/ingestion-v2-resolve.js"
import { checkPlainGitUrl } from "../domain/workspace-sources/providers/git.js"
import { normalizeWorkspaceRepositoryUrl } from "../domain/workspaces/slug.js"
import { githubRepoFullNameFromWorkspaceUrl } from "../domain/workspaces/write-status.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { repositoryIngestionV2 } from "./workflows/repository-ingestion-v2.js"

type IngestionV2ShadowStart =
  | { started: true; runId: string }
  | {
      started: false
      /**
       * `unsupported_url`: a repository with no GitHub connection whose URL
       * is not a plain git URL that ctx| reads (CTX-815).
       */
      reason: "unsupported_url" | "repository_gone"
    }

type IngestionV2PublishStart =
  | IngestionV2ShadowStart
  | { started: false; reason: "no_v2_destination" }

type StartInput = {
  orgId: string
  repositoryId: string
  sha: string
  triggerRunId: string
}

/**
 * The shadow trigger (T09): after `repository-ingestion` indexed `sha` of a
 * repository, queue one ingestion v2 run in shadow mode at the same SHA. The
 * caller checks `ingestionV2ShadowEnabled` first. The trigger run's id is the
 * idempotency key, so a replayed trigger step queues nothing new.
 */
export function startIngestionV2Shadow(
  input: StartInput,
): Promise<IngestionV2ShadowStart> {
  return startIngestionV2Run(input, {
    shadow: true,
  }) as Promise<IngestionV2ShadowStart>
}

/**
 * The publish trigger (ADR-052 phase 4, G5): after `repository-ingestion`
 * indexed `sha` of a repository, queue one ingestion v2 run that publishes,
 * when a Workspace that declares the repository is at format 3 or more. The
 * check reads the cached format; the run reads the format of each pinned
 * tree again before it publishes. No ingestion writes to a Workspace below
 * format 3.
 */
export function startIngestionV2Publish(
  input: StartInput,
): Promise<IngestionV2PublishStart> {
  return startIngestionV2Run(input, { shadow: false })
}

/**
 * The ingestion source of an org repository: a GitHub repository with its
 * connection, else a plain git repository that ctx| reads with no
 * credential under the plain git URL policy of the deployment mode, as the
 * old ingestion on main read it (CTX-815). Null when neither applies.
 */
function ingestSourceOf(repository: {
  gitUrl: string
  githubConnectionId: string | null
}): IngestSource | null {
  const url = normalizeWorkspaceRepositoryUrl(repository.gitUrl)
  if (repository.githubConnectionId && githubRepoFullNameFromWorkspaceUrl(url))
    return {
      kind: "github",
      url,
      githubConnectionId: repository.githubConnectionId,
    }
  // The raw URL: the normalized form drops a user name and `.git`.
  const plain = checkPlainGitUrl(repository.gitUrl)
  return plain.ok ? { kind: "git", url: plain.url } : null
}

async function startIngestionV2Run(
  input: StartInput,
  options: { shadow: boolean },
): Promise<IngestionV2PublishStart> {
  const [repository] = await withOrgDbContext(input.orgId, (db) =>
    db
      .select({
        gitUrl: repositories.gitUrl,
        githubConnectionId: repositories.githubConnectionId,
      })
      .from(repositories)
      .where(eq(repositories.id, input.repositoryId))
      .limit(1),
  )
  if (!repository) return { started: false, reason: "repository_gone" }
  const source = ingestSourceOf(repository)
  if (!source) return { started: false, reason: "unsupported_url" }
  if (!options.shadow) {
    const resolved = await resolveIngestionV2Run({
      orgId: input.orgId,
      source,
      shadow: false,
    })
    if (resolved.skipped || !resolved.destinations.length)
      return { started: false, reason: "no_v2_destination" }
  }
  const handle = await runWorkflowWithWorkerWake(
    repositoryIngestionV2.spec,
    {
      orgId: input.orgId,
      shadow: options.shadow,
      source,
      sha: input.sha,
      authorTime: new Date().toISOString(),
    } satisfies IngestionV2Input,
    {
      idempotencyKey: `ingestion-v2-${options.shadow ? "shadow" : "publish"}:${input.triggerRunId}`,
    },
  )
  return { started: true, runId: handle.workflowRun.id }
}
