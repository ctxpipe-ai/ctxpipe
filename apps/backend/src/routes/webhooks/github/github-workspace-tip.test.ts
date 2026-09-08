import { expect, it } from "vitest"
import { withOrgIdContext } from "../../../auth/withAuth.js"
import { parseEnv } from "../../../config/env.js"
import type { GithubRepoPermissionBits } from "../../../domain/workspaces/write-status.js"
import { withNativeHydrationFixture } from "../../../test/native-hydration-fixture.js"
import { getGithubRepoWriteView } from "./github-workspace-tip.js"

const cases: Array<{
  name: string
  repository: GithubRepoPermissionBits | null
  installation?: GithubRepoPermissionBits
  canPush: boolean
  appProbe: boolean
}> = [
  {
    name: "repository contents write",
    repository: { contents: "write" },
    canPush: true,
    appProbe: false,
  },
  {
    name: "repository push",
    repository: { push: true },
    canPush: true,
    appProbe: false,
  },
  {
    name: "accessible repository without permission bits",
    repository: null,
    canPush: true,
    appProbe: false,
  },
  {
    name: "installation contents write",
    repository: { pull: true },
    installation: { contents: "write" },
    canPush: true,
    appProbe: true,
  },
  {
    name: "pull-only installation",
    repository: { pull: true },
    installation: { contents: "read" },
    canPush: false,
    appProbe: true,
  },
]

it.each(cases)(
  "probes $name with repository read credentials and app authentication",
  { timeout: 30_000 },
  async (example) => {
    await withNativeHydrationFixture(
      {
        github: true,
        githubWriteView: "writable",
        githubRepoPermissions: example.repository,
        githubInstallationPermissions: example.installation,
      },
      async (f) => {
        await expect(
          withOrgIdContext(f.org, () =>
            getGithubRepoWriteView({
              orgId: f.org.id,
              githubConnectionId: f.connectionId,
              repoFullName: "fixture/hydration-contract",
              env: parseEnv(process.env),
            }),
          ),
        ).resolves.toEqual({ defaultBranch: "main", canPush: example.canPush })
        expect(f.tokenRequests).toEqual([
          {
            repositories: ["hydration-contract"],
            permissions: { contents: "read", metadata: "read" },
          },
        ])
        expect(f.appPermissionRequests).toEqual(
          example.appProbe ? [{ usesAppAuth: true }] : [],
        )
      },
    )
  },
)

it(
  "does not classify a missing local installation as a GitHub repository denial",
  { timeout: 30_000 },
  async () => {
    await withNativeHydrationFixture({}, async (f) => {
      const error = await withOrgIdContext(f.org, () =>
        getGithubRepoWriteView({
          orgId: f.org.id,
          githubConnectionId: f.connectionId,
          repoFullName: "fixture/hydration-contract",
          env: parseEnv(process.env),
        }),
      ).catch((error: unknown) => error)
      expect(error).toMatchObject({ message: "GitHub installation not found" })
      expect(error).not.toHaveProperty("status")
      expect(f.tokenRequests).toEqual([])
    })
  },
)
