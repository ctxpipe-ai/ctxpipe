import { HttpResponse, http } from "msw"
import { expect, it } from "vitest"

import { withOrgIdContext } from "../../../auth/withAuth.js"
import { parseEnv } from "../../../config/env.js"
import { withOrgDbContext } from "../../../db/client.js"
import { workspaces } from "../../../db/schema/workspaces.js"
import { upsertInstallation } from "../../../models/github-installation.js"
import { getWorkspaceById } from "../../../models/workspaces.js"
import { withNativeHydrationFixture } from "../../../test/native-hydration-fixture.js"
import { processGithubWebhookPayload } from "./github.js"

it(
  "binds a Paste workspace when the deployment App gets access to its repository",
  { timeout: 45_000 },
  async () => {
    // Coverage reads the repository id, so GitHub must answer `repos.get`.
    await withNativeHydrationFixture(
      { github: true, githubWriteView: "writable" },
      async (f) => {
        await f.handle.cancel()
        const env = parseEnv(process.env)
        // Write the connection directory, as the hosted install does.
        const connection = await upsertInstallation(f.org.id, 123456789, env)
        let covered = false
        // Until access is given, GitHub refuses a token for the repository.
        f.server.use(
          http.post(
            "https://api.github.com/app/installations/123456789/access_tokens",
            async ({ request }) => {
              const body = (await request.clone().json()) as {
                repositories?: string[]
              }
              if (!covered && body.repositories?.includes("added-later"))
                return HttpResponse.json(
                  {
                    message:
                      "There is at least one repository that does not exist or is not accessible to the parent installation.",
                  },
                  { status: 422 },
                )
              return undefined
            },
          ),
        )
        const pastedId = `${f.workspaceId}_pasted`
        await withOrgDbContext(f.org.id, (db) =>
          db.insert(workspaces).values({
            id: pastedId,
            orgId: f.org.id,
            slug: "added-later",
            displayName: "Added later",
            workspaceRepositoryUrl: "https://github.com/fixture/added-later",
            writeStatus: "read_only",
          }),
        )
        const errors: string[] = []
        const ctx = {
          env,
          log: { error: (error: Error) => errors.push(error.message) },
        } as unknown as Parameters<typeof processGithubWebhookPayload>[2]
        const event = (action: string, fullName: string) =>
          processGithubWebhookPayload(
            "installation_repositories",
            {
              action,
              installation: { id: 123456789 },
              repositories_added: [{ full_name: fullName }],
            },
            ctx,
          )
        const pasted = () =>
          withOrgIdContext(f.org, () => getWorkspaceById(pastedId))

        await event("added", "fixture/added-later")
        expect(await pasted()).toMatchObject({ githubConnectionId: null })

        covered = true
        await event("removed", "fixture/added-later")
        expect(await pasted()).toMatchObject({ githubConnectionId: null })
        // An access change for another repository does not check this one.
        await event("added", "fixture/other")
        expect(await pasted()).toMatchObject({ githubConnectionId: null })

        await event("added", "fixture/added-later")
        expect(await pasted()).toMatchObject({
          githubConnectionId: connection.id,
          writeStatus: "unknown",
        })
        expect(errors).toEqual([])
      },
    )
  },
)
