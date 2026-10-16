import type { Env } from "../../config/env.js"
import type { ModelTier } from "../../retrieval/services/providers/providerTypes.js"
import { parseSandboxCallbackHost } from "../workspaces/sandbox-callback-host.js"
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
  /** The Workspace root folder; absent or `""` is the repository root. */
  rootPath?: string
  /**
   * The path of the GitHub source file that declares the run's repository in
   * this Workspace (`sources/github/<owner>/<name>.md`, ADR-050 revision
   * 2026-10-16). Each file that the run owns lists it in `sources`.
   */
  sourcePath: string
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
  /** The root path of a root step; null for a repository-wide step. */
  root: string | null
  workspaceId: string
  /** The commit that the step stages against: the ref tip or the pinned revision. */
  baseCommit: string
  /** The ref to fetch before the step; absent when the base is the pinned revision. */
  fetchRef?: string
  /** The root-to-file map (`--roots`); every step gets it (ADR-052 section 6). */
  rootMap: IngestRootMap
  signal: AbortSignal
}

/**
 * The `--roots` file of each step (ADR-052 section 6): each planned root of
 * the run, and the context files that the root's steps wrote.
 */
export type IngestRootMap = {
  roots: Array<{
    path: string
    manifests: string[]
    evidence: string[]
    files: string[]
  }>
}

export type IngestShardRuntime = {
  /** Make or attach to the sandbox, and prepare it. Idempotent. */
  ensure(): Promise<void>
  /** Run the `discover-roots` script; return its parsed JSON result. */
  discoverRoots(): Promise<unknown>
  /**
   * Run one skill step; return the tar of `/ctxpipe/out`. Its `patch.json`
   * holds `more` when files wait for a next page; the host reads it.
   */
  runStep(step: IngestRuntimeStep): Promise<{ tar: Uint8Array }>
}

export type IngestShardRuntimeFactory = {
  (spec: IngestShardSpec): IngestShardRuntime
  /**
   * Delete the sandbox of one shard and revoke its credentials. It makes no
   * sandbox and no credential. Idempotent.
   */
  destroy(target: {
    orgId: string
    runId: string
    shard: number
    /** The first destination of the shard: the sandbox row's Workspace. */
    workspaceId: string
  }): Promise<void>
}

/**
 * The API origin that a shard sandbox calls for the model proxy and the tool
 * bridge. Shard steps run in the worker, which serves no HTTP, so this is
 * never the worker's own address or port. It is `AUTH_BASE_URL` (the API
 * origin on Railway and AWS), with two changes:
 * - `SANDBOX_CALLBACK_HOST` names the API on the sandbox network (Compose):
 *   plain HTTP to that host, on `PORT`. Compose gives the worker the `PORT`
 *   of the API service config. The port of `AUTH_BASE_URL` is the public
 *   port, which can be another. The host is checked as for the chat callback;
 * - a `localhost` API (host dev) is `host.docker.internal` from a container.
 */
export function ingestCallbackOrigin(
  env: Pick<Env, "AUTH_BASE_URL" | "SANDBOX_CALLBACK_HOST" | "PORT">,
): string {
  if (env.SANDBOX_CALLBACK_HOST)
    return new URL(
      `http://${parseSandboxCallbackHost(env.SANDBOX_CALLBACK_HOST.trim())}:${env.PORT}`,
    ).origin
  const api = new URL(env.AUTH_BASE_URL)
  if (
    ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname) ||
    api.hostname.endsWith(".localhost")
  )
    api.hostname = "host.docker.internal"
  return api.origin
}
