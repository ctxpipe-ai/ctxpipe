import { APIError, Sandbox, Snapshot } from "@vercel/sandbox"
import {
  type VercelCredentials,
  vercelCredentials,
} from "../domain/workspaces/vercel-sandbox-provider.js"
import { log } from "../observability/logger.js"

/** Railway names preview environments `pr-<number>`; nothing else is cleaned here. */
const PREVIEW_ENVIRONMENT = /^pr-\d+$/

function notFound(error: unknown): boolean {
  return error instanceof APIError && error.response.status === 404
}

/**
 * Delete every hosted chat sandbox a closed PR preview created, with its
 * saved state. Sandboxes are tagged with the Railway environment name, so the
 * filter never reaches production. Already deleted counts as deleted; any
 * other API error fails the run.
 */
export async function deletePreviewSandboxes(input: {
  credentials: VercelCredentials
  environment: string
}): Promise<{ sandboxes: number; snapshots: number }> {
  const { credentials, environment } = input
  if (!PREVIEW_ENVIRONMENT.test(environment))
    throw new Error(
      `Refusing to delete sandboxes outside a PR preview: "${environment}"`,
    )
  const listed = await (
    await Sandbox.list({
      ...credentials,
      tags: { ctxpipe: "workspace-chat", environment },
    })
  ).toArray()
  // The tag filter is the server's; check it again before deleting anything.
  const names = listed
    .filter((sandbox) => sandbox.tags?.environment === environment)
    .map((sandbox) => sandbox.name)
  let snapshots = 0
  for (const name of names) {
    // Listed first, so the saved state is still found by sandbox name.
    const saved = (
      await (await Snapshot.list({ ...credentials, name })).toArray()
    ).filter((snapshot) => snapshot.status !== "deleted")
    try {
      const sandbox = await Sandbox.get({ ...credentials, name, resume: false })
      await sandbox.delete()
    } catch (error) {
      if (!notFound(error)) throw error
    }
    for (const { id } of saved) {
      try {
        const snapshot = await Snapshot.get({ ...credentials, snapshotId: id })
        if (snapshot.status === "deleted") continue
        await snapshot.delete()
        snapshots += 1
      } catch (error) {
        if (!notFound(error)) throw error
      }
    }
  }
  return { sandboxes: names.length, snapshots }
}

const invokedDirectly = process.argv[1]?.includes("deletePreviewSandboxes.ts")

if (invokedDirectly) {
  const environment = process.argv[2] ?? ""
  const deleted = await deletePreviewSandboxes({
    credentials: await vercelCredentials(),
    environment,
  })
  log.info({
    step: "preview-sandbox-cleanup",
    message: `Deleted ${deleted.sandboxes} sandboxes and ${deleted.snapshots} saved snapshots for ${environment}`,
    environment,
    ...deleted,
  })
}
