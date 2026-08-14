import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { RepositoriesPageContent } from "./$orgSlug.repositories.index"

const orgSlug = "acme"

function makeIndexedRepos(count: number) {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const name = `svc-${String(n).padStart(3, "0")}`
    const status =
      i % 41 === 0
        ? "failed"
        : i % 23 === 0
          ? "running"
          : i % 17 === 0
            ? "queued"
            : "ready"
    return {
      id: `repo_${n}`,
      orgId: "org_acme",
      zoektRepoId: n,
      name: `acme/${name}`,
      gitUrl: `https://github.com/acme/${name}.git`,
      indexReady: status === "ready",
      indexingStatus: status,
      indexingError: status === "failed" ? "Clone timed out" : null,
      indexingFailedAt: null,
      indexingReason: null,
      indexingStep: status === "running" ? 7 : null,
      indexingStepTotal: status === "running" ? 22 : null,
      indexingStepKey: status === "running" ? "embedding" : null,
      lastIngestedHash:
        status === "ready" ? `abc${String(n).padStart(4, "0")}` : null,
      lastIngestedAt:
        status === "ready"
          ? new Date(
              now - (i % 12) * 3600_000 - (i % 40) * 60_000,
            ).toISOString()
          : null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      githubConnectionId: "con_github_1",
    }
  })
}

const manyRepos = makeIndexedRepos(400)
const pendingSaved = Array.from({ length: 8 }, (_, i) => {
  const name = `pending-${String(i + 1).padStart(2, "0")}`
  return {
    name: `acme/${name}`,
    gitUrl: `https://github.com/acme/${name}.git`,
  }
})

const meta = {
  title: "Pages/Repositories",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const FourHundredSources: Story = {
  render: () => <RepositoriesPageContent orgSlug={orgSlug} />,
  parameters: {
    storyRoute: {
      pattern: "orgRepositories",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(`/${orgSlug}/api/v1/github/installation/setup`, () =>
            HttpResponse.json({
              ingestAllRepositories: false,
              includeFutureRepos: false,
              savedRepositories: [
                ...manyRepos.map((repo) => ({
                  name: repo.name,
                  gitUrl: repo.gitUrl,
                })),
                ...pendingSaved,
              ],
            }),
          ),
          http.get(`/${orgSlug}/api/v1/github/installation/repositories`, () =>
            HttpResponse.json({
              repositories: [],
              repositorySelection: "selected",
              manageUrl:
                "https://github.com/organizations/acme/settings/installations/1",
              hasMore: false,
            }),
          ),
          http.get(`/${orgSlug}/api/v1/github/installation`, () =>
            HttpResponse.json({
              id: "con_github_1",
              appSlug: "ctxpipe",
            }),
          ),
          http.get(`/${orgSlug}/api/v1/repositories`, () =>
            HttpResponse.json({ items: manyRepos }),
          ),
        ],
      },
    },
  },
}
