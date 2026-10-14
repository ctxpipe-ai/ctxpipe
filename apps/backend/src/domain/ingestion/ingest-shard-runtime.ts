import type { ModelTier } from "../../retrieval/services/providers/providerTypes.js"
import type { IngestSkillBundle } from "./skill-bundle.js"

/*
 * The sandbox side of one ingest shard (ADR-052 sections 7 and 8). The
 * workflow steps are on the host; each step calls this runtime for the work
 * that runs in the sandbox. The production runtime uses the shard's Docker or
 * Vercel sandbox (`sandboxIngestShardRuntime`). The sandbox is a cache: each
 * method makes the sandbox again when it is gone, and git holds each finished
 * step.
 */

/** A destination Workspace of the run, as `resolve` read it. */
export type IngestDestination = {
  workspaceId: string
  /** The Workspace repository (a GitHub URL), and its connection. */
  url: string
  githubConnectionId: string
  /** The binding generation that the broker checks for each ref job. */
  generation: number
  /** The default-branch commit that each shard ref starts at. */
  pinnedRevision: string
  /** The org repository row of the Workspace repository, for the tool bridge. */
  repositoryId: string | null
}

export type IngestShardSpec = {
  orgId: string
  /** The ingestion v2 run: it names the refs, the sandbox, and the lock. */
  runId: string
  shard: number
  bundle: IngestSkillBundle
  source: {
    url: string
    githubConnectionId: string
    sha: string
    repositoryId: string | null
  }
  destinations: IngestDestination[]
}

export type IngestRuntimeStep = {
  /** The workflow step name, for attribution. */
  name: string
  skill: string
  run: "script" | "model"
  tier?: ModelTier
  /** A root path of the source, or `.` for a repository-wide skill. */
  root: string
  workspaceId: string
  /** The commit that the step stages against: the ref tip or the pinned revision. */
  baseCommit: string
  /** The ref to fetch before the step; absent when the base is the pinned revision. */
  fetchRef?: string
  signal: AbortSignal
}

export type IngestShardRuntime = {
  /** Make or attach to the sandbox, and prepare it. Idempotent. */
  ensure(): Promise<void>
  /** Run the `discover-roots` script; return each root path it found. */
  discoverRoots(): Promise<string[]>
  /** Run one skill step; return the tar of `/ctxpipe/out`. */
  runStep(step: IngestRuntimeStep): Promise<Uint8Array>
  /** Delete the sandbox and revoke its credentials. Idempotent. */
  destroy(): Promise<void>
}

export type IngestShardRuntimeFactory = (
  spec: IngestShardSpec,
) => IngestShardRuntime
