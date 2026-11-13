import { Sandbox } from "@vercel/sandbox"

import {
  deleteVercelBuilder,
  deleteVercelSandbox,
  type VercelCredentials,
  vercelCredentials,
} from "../domain/workspaces/vercel-sandbox-provider.js"
import { log } from "../observability/logger.js"

// Railway names preview environments `pr-<number>`; nothing else is cleaned here.
const PREVIEW = /^pr-\d+$/

/**
 * Delete every hosted sandbox a PR preview created: chat sandboxes with their
 * saved state, and the builders of Workspace bases and agent snapshots (any
 * OpenCode version) with the snapshots taken from them. `environment` is one
 * preview (`pr-<number>`). Only a sandbox whose
 * `environment` tag is exactly `pr-<number>` is deleted, so production and
 * untagged sandboxes stay. Snapshots carry no tags; they go with their
 * builder or chat sandbox.
 *
 * Already deleted counts as deleted. Another API error does not stop the
 * run: the remaining sandboxes are deleted, then the first error is thrown.
 * Returns the names of the deleted sandboxes.
 */
export async function deletePreviewSandboxes(input: {
  credentials: VercelCredentials
  environment: string
}): Promise<string[]> {
  const { credentials, environment } = input
  if (!PREVIEW.test(environment))
    throw new Error(
      `Refusing to delete sandboxes outside a PR preview: "${environment}"`,
    )
  // The API filters a list on one tag; check the tag here too, as a filter
  // that returns too much must never delete a production sandbox.
  const listed = await (
    await Sandbox.list({
      ...credentials,
      tags: { environment },
    })
  ).toArray()
  const doomed = listed.filter(
    (sandbox) => sandbox.tags?.environment === environment,
  )
  const deleted: string[] = []
  const errors: unknown[] = []
  for (const sandbox of doomed) {
    try {
      if (sandbox.tags?.ctxpipe === "workspace-chat")
        await deleteVercelSandbox({ credentials, name: sandbox.name })
      else await deleteVercelBuilder({ credentials, builderName: sandbox.name })
      deleted.push(sandbox.name)
      log.info({
        step: "preview-sandbox-cleanup",
        message: `Deleted sandbox ${sandbox.name} (${sandbox.tags?.environment})`,
        sandbox: sandbox.name,
        environment: sandbox.tags?.environment,
      })
    } catch (error) {
      errors.push(error)
      log.warn({
        step: "preview-sandbox-cleanup",
        message: `Deleting sandbox ${sandbox.name} failed: ${String(error)}`,
        sandbox: sandbox.name,
        environment: sandbox.tags?.environment,
      })
    }
  }
  if (errors.length > 0) throw errors[0]
  return deleted
}

if (import.meta.main) {
  const environment = process.argv[2] ?? ""
  vercelCredentials()
    .then((credentials) => deletePreviewSandboxes({ credentials, environment }))
    .then((deleted) =>
      log.info({
        step: "preview-sandbox-cleanup",
        message: `Deleted ${deleted.length} sandboxes for ${environment}: ${deleted.join(", ")}`,
        environment,
        deleted: deleted.length,
      }),
    )
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    })
}
