/**
 * Measure the time to ready of a Docker conversation sandbox with and
 * without a Workspace base, on a large public repository. Ticket 03 records
 * the numbers.
 *
 * Needs Docker, the chat sandbox image, and a migrated database
 * (`pnpm dev:infra`, `pnpm db:migrate`). From apps/backend:
 *
 *   DATABASE_URL=… bun run src/scripts/workspaceBaseTimeToReady.ts [repository-url]
 *
 * The repository must be public: GitHub asks for no credential, so the
 * fixture token is never sent.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import Docker from "dockerode"
import { eq } from "drizzle-orm"
import { withOrgIdContext } from "../auth/withAuth.js"
import { closeDb, withOrgDbContext } from "../db/client.js"
import { workspaces } from "../db/schema/workspaces.js"
import { destroySandboxesForWorkspace } from "../domain/workspaces/workspace-sandbox-cleanup.js"
import { closeOpenWorkflowClient } from "../openworkflow/client.js"
import { CHAT_IMAGE, dockerChat } from "../test/docker-workspace-base.js"
import { withNativeChatFixture } from "../test/native-chat-fixture.js"

const url = process.argv[2] ?? "https://github.com/facebook/react.git"
const { stdout } = await promisify(execFile)("git", ["ls-remote", url, "HEAD"])
const sha = stdout.split(/\s/)[0]
if (!sha) throw new Error(`No HEAD for ${url}`)
const docker = new Docker({ timeout: 60_000 })

try {
  await withNativeChatFixture(async (f) => {
    // After the fixture sets its own provider. The process ends after this.
    process.env.SANDBOX_PROVIDER = "docker"
    process.env.SANDBOX_CHAT_IMAGE = CHAT_IMAGE
    await withOrgDbContext(f.orgId, (db) =>
      db
        .update(workspaces)
        .set({ workspaceRepositoryUrl: url, desiredSha: sha })
        .where(eq(workspaces.id, f.workspaceId)),
    )
    await withOrgIdContext({ id: f.orgId, slug: f.orgSlug }, async () => {
      const chat = dockerChat(f, url)
      try {
        const without = await chat.warm(await chat.conversation(), sha)
        if ((await chat.head(without.handle)) !== sha)
          throw new Error("The sandbox without a base is not at the SHA")
        const started = Date.now()
        const image = await chat.build()
        const buildMs = Date.now() - started
        if (!image) throw new Error("The base build returned no image")
        const withBase = await chat.warm(await chat.conversation(), sha)
        if ((await chat.imageOf(withBase.handle.id)) !== image)
          throw new Error("The sandbox did not start from the base")
        if ((await chat.head(withBase.handle)) !== sha)
          throw new Error("The sandbox with a base is not at the SHA")
        const size = async (ref: string) =>
          (await docker.getImage(ref).inspect()).Size
        const added = (await size(image)) - (await size(CHAT_IMAGE))
        process.stdout.write(
          `[workspace-base] ${url} at ${sha.slice(0, 12)}: ready without base ${without.ms}ms, with base ${withBase.ms}ms; base build ${buildMs}ms; the base adds ${Math.round(added / 1e6)}MB to the chat image\n`,
        )
      } finally {
        await destroySandboxesForWorkspace(f.workspaceId)
      }
    })
  })
} finally {
  await closeOpenWorkflowClient()
  await closeDb()
}
