import { Sandbox } from "@vercel/sandbox"
import {
  conversationSandboxTags,
  deleteVercelSandbox,
  type VercelCredentials,
  vercelCredentials,
  workspaceBaseTags,
} from "../domain/workspaces/vercel-sandbox-provider.js"
import { log } from "../observability/logger.js"

/**
 * Delete every hosted chat sandbox a closed PR preview created, with its
 * saved state, and every Workspace base builder with its base snapshot.
 * Sandboxes are tagged with the Railway environment name, so the filter
 * never reaches production. Already deleted counts as deleted; any other API
 * error fails the run. Returns how many sandboxes were deleted.
 */
export async function deletePreviewSandboxes(input: {
  credentials: VercelCredentials
  environment: string
}): Promise<number> {
  const { credentials, environment } = input
  // Railway names preview environments `pr-<number>`; nothing else is cleaned here.
  if (!/^pr-\d+$/.test(environment))
    throw new Error(
      `Refusing to delete sandboxes outside a PR preview: "${environment}"`,
    )
  const names: string[] = []
  for (const tags of [
    conversationSandboxTags(environment),
    workspaceBaseTags(environment),
  ]) {
    const listed = await (
      await Sandbox.list({ ...credentials, tags })
    ).toArray()
    // The tag filter is the server's; check it again before deleting anything.
    names.push(
      ...listed
        .filter((sandbox) =>
          Object.entries(tags).every(
            ([key, value]) => sandbox.tags?.[key] === value,
          ),
        )
        .map((sandbox) => sandbox.name),
    )
  }
  // A base builder's snapshots (the base itself) are listed under its name.
  for (const name of names) await deleteVercelSandbox({ credentials, name })
  return names.length
}

if (import.meta.main) {
  const environment = process.argv[2] ?? ""
  vercelCredentials()
    .then((credentials) => deletePreviewSandboxes({ credentials, environment }))
    .then((deleted) =>
      log.info({
        step: "preview-sandbox-cleanup",
        message: `Deleted ${deleted} sandboxes for ${environment}`,
        environment,
        deleted,
      }),
    )
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exit(1)
    })
}
