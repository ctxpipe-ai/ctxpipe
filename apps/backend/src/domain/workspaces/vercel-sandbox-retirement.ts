import { createHash } from "node:crypto"

import {
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3"
import { APIError } from "@vercel/sandbox"

import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
  ownershipOf,
  type SandboxInstanceRecord,
} from "../../models/workspace-sandboxes.js"
import { log } from "../../observability/logger.js"
import { CHAT_SANDBOX_RETENTION_MS } from "./chat-lifecycle.js"
import { pushBeforeSandboxDelete } from "./conversation-branch-push.js"
import { sandboxFileChunks, sandboxFileSize } from "./conversation-publish.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import { withSandboxLockIfFree } from "./sandbox-lock-store.js"
import {
  destroyDetachedProviderSandbox,
  lockedSandboxProvider,
} from "./sandbox-provider.js"
import { deleteWorkspaceBaseArtifacts } from "./workspace-base-providers.js"
import { workspaceBaseHeldUntil } from "./workspace-sandbox-cleanup.js"

/**
 * True for a `vercel` sandbox row while the deployment does not lock
 * `SANDBOX_PROVIDER=vercel` (a rollback to Vercel). Only
 * `retireVercelSandboxes` deletes such a row; the other sweep steps skip it.
 */
export function retiresVercelRow(row: { provider?: string | null }): boolean {
  return row.provider === "vercel" && lockedSandboxProvider() !== "vercel"
}

/**
 * Retire the org's `vercel` sandbox rows (CTX-1220, ADR-061 decision 18).
 * Hosted sandboxes moved to AgentCore, and Vercel still keeps the Workspace
 * base snapshots (copies of customer repositories) and the conversation,
 * job and ingest sandboxes of the earlier rows. The org's sandbox sweep
 * calls this first. For each row, it deletes the Vercel resource with the
 * existing provider code (a base: its builder and snapshots; another kind:
 * the sandbox, its snapshots and its GitHub token), then the row. Bases go
 * last, after the sandboxes that can have started from them.
 *
 * A conversation sandbox is deleted as the sweep deletes one: under the
 * conversation's lock, after its committed work is pushed to GitHub. It
 * stays while the conversation is busy, and while a push must retry until
 * its retention ends. A row whose delete fails also stays, and so does a
 * base that a conversation sandbox which stays can have started from.
 *
 * When the push refuses the commits because of what they change (for
 * example `generated_by` front matter), no retry can push them. With
 * `RETIRED_SANDBOX_STORE` (`s3://bucket/prefix`), the commits that no remote
 * has go there as a Git bundle, at
 * `<prefix>/<orgId>/<conversationId>/<row id>.bundle`, and then the sandbox
 * goes. Such a row stays while its bundle fails, also after its retention.
 * Without the setting (a self-hosted deployment), the row stays until its
 * retention ends, as for a push that must retry.
 *
 * Returns the number of rows that stay, so that the sweep runs again soon.
 * The worker keeps `VERCEL_TOKEN` for this. The later change that removes
 * the Vercel provider code refuses to start while a `vercel` row stays.
 * Logs hold counts and HTTP status codes only.
 */
export async function retireVercelSandboxes(
  orgId: string,
  now: Date,
): Promise<{ left: number }> {
  const rows = (
    await withOrgDbContext(orgId, () => listSandboxInstances({}))
  ).filter(retiresVercelRow)
  let retired = 0
  let bundled = 0
  let kept = 0
  let failed = 0
  // The conversation sandboxes that stay keep the bases they can have
  // started from, as in the base cleanup.
  const stayed: SandboxInstanceRecord[] = []
  for (const row of [
    ...rows.filter((item) => item.kind !== "base"),
    ...rows.filter((item) => item.kind === "base"),
  ]) {
    try {
      const outcome =
        row.kind === "base" && workspaceBaseHeldUntil(row, stayed) !== null
          ? "kept"
          : await retire(row, now)
      if (outcome === "kept") {
        kept += 1
        if (row.kind !== "base") stayed.push(row)
      } else {
        retired += 1
        if (outcome === "bundled") bundled += 1
      }
    } catch (error) {
      failed += 1
      stayed.push(row)
      // The error text can hold a snapshot id: log the kind and status only.
      log.warn({
        step: "vercel-sandbox-retirement",
        message: `Retiring a Vercel sandbox failed (kind ${row.kind})`,
        kind: row.kind,
        ...(error instanceof APIError ? { status: error.response.status } : {}),
      })
    }
  }
  if (rows.length)
    log.info({
      step: "vercel-sandbox-retirement",
      message: `Retired ${retired} Vercel sandboxes (${bundled} saved as Git bundles); ${kept} kept, ${failed} failed`,
      retired,
      bundled,
      kept,
      failed,
    })
  return { left: kept + failed }
}

/** Delete the row's Vercel resource, then the row, or keep both for now. */
async function retire(
  row: SandboxInstanceRecord,
  now: Date,
): Promise<"retired" | "bundled" | "kept"> {
  const { conversationId } = row
  if (row.kind !== "chat" || !conversationId) {
    await deleteRow(row)
    return "retired"
  }
  const store = process.env.RETIRED_SANDBOX_STORE?.trim()
  // Set only when the push refused the commits: then they are saved or the
  // row stays.
  let bundle: "saved" | "failed" | undefined
  const outcome = await withSandboxLockIfFree(
    row.orgId,
    `chat-thread:${conversationId}`,
    async () => {
      const pushed =
        row.providerSandboxId && row.revision
          ? await pushBeforeSandboxDelete({
              orgId: row.orgId,
              conversationId,
              workspaceId: row.workspaceId,
              provider: "vercel",
              providerSandboxId: row.providerSandboxId,
              baseSha: row.revision.sha,
              ...(store
                ? {
                    saveRefused: async (handle: JobSandboxHandle) => {
                      const saved = await saveBundle(
                        handle,
                        store,
                        `${row.orgId}/${conversationId}/${row.id}.bundle`,
                      )
                      bundle = saved ? "saved" : "failed"
                      return saved
                    },
                  }
                : {}),
            })
          : "done"
      if (
        pushed === "retry" &&
        (bundle === "failed" ||
          now.getTime() - row.lastHeartbeatAt.getTime() <
            CHAT_SANDBOX_RETENTION_MS)
      )
        return false
      await deleteRow(row)
      return true
    },
  )
  if (outcome.busy || !outcome.value) return "kept"
  return bundle === "saved" ? "bundled" : "retired"
}

/**
 * Save the sandbox's commits that no remote has as a Git bundle in the
 * store (`s3://bucket/prefix`), at `<prefix>/<name>`. The bucket is private
 * and encrypts each object. False: nothing was saved; the log line holds the
 * HTTP status only. The success line holds a hash of the key, not the key,
 * because the key holds ids.
 */
async function saveBundle(
  handle: JobSandboxHandle,
  store: string,
  name: string,
): Promise<boolean> {
  try {
    const location = /^s3:\/\/([^/]+)\/(.+?)\/?$/.exec(store)
    if (!location)
      throw new Error(
        "RETIRED_SANDBOX_STORE must have the form s3://bucket/prefix",
      )
    const [, bucket, prefix] = location
    const run = (command: string) => handle.exec(command, { env: {} })
    const path = ".git/ctxpipe-retired.bundle"
    const created = await run(
      `git bundle create ${path} HEAD --branches --not --remotes`,
    )
    if (created.exitCode !== 0) throw new Error("git bundle create failed")
    const chunks: Buffer[] = []
    for await (const chunk of sandboxFileChunks(
      run,
      path,
      await sandboxFileSize(run, path),
    ))
      chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (!/^# v[23] git bundle\n/.test(body.subarray(0, 32).toString("latin1")))
      throw new Error("The sandbox wrote no Git bundle")
    const key = `${prefix}/${name}`
    await new S3Client({}).send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
    )
    log.info({
      step: "vercel-sandbox-retirement",
      message: "Saved the refused commits of a Vercel sandbox as a Git bundle",
      bundleKeySha256: createHash("sha256").update(key).digest("hex"),
    })
    return true
  } catch (error) {
    log.warn({
      step: "vercel-sandbox-retirement",
      message: "Saving the refused commits of a Vercel sandbox failed",
      ...(error instanceof S3ServiceException
        ? { status: error.$metadata.httpStatusCode }
        : {}),
    })
    return false
  }
}

async function deleteRow(row: SandboxInstanceRecord): Promise<void> {
  // The provider code counts a resource that Vercel no longer has as deleted.
  if (row.kind === "base") await deleteWorkspaceBaseArtifacts(row)
  else if (row.providerSandboxId)
    await destroyDetachedProviderSandbox({
      orgId: row.orgId,
      provider: "vercel",
      providerSandboxId: row.providerSandboxId,
    })
  // Only while the row is the one that was read: a row that another writer
  // changed stays for the next sweep.
  await deleteSandboxInstance(row.id, row.orgId, ownershipOf(row))
}
