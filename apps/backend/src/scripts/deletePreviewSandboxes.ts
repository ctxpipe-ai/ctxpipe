import {
  agentSnapshotTags,
  conversationSandboxTags,
  deleteVercelBuilder,
  deleteVercelSandbox,
  listTaggedSandboxes,
  type VercelCredentials,
  vercelCredentials,
  workspaceBaseTags,
} from "../domain/workspaces/vercel-sandbox-provider.js"
import { log } from "../observability/logger.js"

/**
 * Delete every hosted sandbox a closed PR preview created: chat sandboxes
 * with their saved state, and the builders of Workspace bases and agent
 * snapshots (any OpenCode version) with the snapshots taken from them.
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
  const tagged = async (tags: Record<string, string>) =>
    (await listTaggedSandboxes(credentials, tags)).map(
      (sandbox) => sandbox.name,
    )
  const chats = await tagged(conversationSandboxTags(environment))
  // Snapshots carry no tags; a builder's are found under its name. Base
  // snapshots of a preview also expire after 30 days, should a builder no
  // longer be listed.
  const builders = [
    ...(await tagged(workspaceBaseTags(environment))),
    ...(await tagged(agentSnapshotTags(environment))),
  ]
  for (const name of chats) await deleteVercelSandbox({ credentials, name })
  for (const builderName of builders)
    await deleteVercelBuilder({ credentials, builderName })
  return chats.length + builders.length
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
