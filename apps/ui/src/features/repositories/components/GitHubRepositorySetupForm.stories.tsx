import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { AppShell } from "@/components/AppShell"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GitHubRepositorySetupForm } from "./GitHubRepositorySetupForm"

const orgSlug = "acme"

function makeGithubRepos(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1
    const name = `svc-${String(n).padStart(3, "0")}`
    return {
      id: n,
      name,
      full_name: `acme/${name}`,
      html_url: `https://github.com/acme/${name}`,
      clone_url: `https://github.com/acme/${name}.git`,
      default_branch: "main",
    }
  })
}

const installationRepos = makeGithubRepos(400)
/** Includes repos that used to sit on page 2+ of a 30-item pager. */
const alreadyIndexed = installationRepos
  .filter((repo) => repo.id % 5 === 0 || repo.id > 30)
  .slice(0, 80)

const meta = {
  title: "Pages/Repositories",
  component: GitHubRepositorySetupForm,
  decorators: [
    (Story) => (
      <AppShell>
        <main className="mx-auto box-border w-full max-w-2xl p-8 text-zinc-100">
          <Story />
        </main>
      </AppShell>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgRepositories",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof GitHubRepositorySetupForm>

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  args: {
    orgSlug,
    setupData: {
      ingestAllRepositories: false,
      includeFutureRepos: false,
      savedRepositories: [],
    },
    onSaveSuccess: () => undefined,
    onCancel: () => undefined,
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/github/installation/repositories`,
            async () => {
              await delay("infinite")
              return HttpResponse.json({ repositories: [] })
            },
          ),
        ],
      },
    },
  },
}

export const FourHundredGitHubPicker: Story = {
  args: {
    orgSlug,
    setupData: {
      ingestAllRepositories: false,
      includeFutureRepos: false,
      savedRepositories: alreadyIndexed.map((repo) => ({
        name: repo.full_name,
        gitUrl: repo.clone_url,
      })),
    },
    onSaveSuccess: () => undefined,
    onCancel: () => undefined,
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/github/installation/repositories`,
            ({ request }) => {
              const url = new URL(request.url)
              const page = Number(url.searchParams.get("page") ?? "1")
              const perPage = Number(url.searchParams.get("per_page") ?? "30")
              const start = (page - 1) * perPage
              const slice = installationRepos.slice(start, start + perPage)
              return HttpResponse.json({
                repositories: slice,
                repositorySelection: "selected",
                manageUrl:
                  "https://github.com/organizations/acme/settings/installations/1",
                hasMore: start + slice.length < installationRepos.length,
              })
            },
          ),
          http.patch(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/github/installation`,
            async ({ request }) => {
              const body = (await request.json()) as {
                ingestAllRepositories: boolean
                includeFutureRepos: boolean
              }
              return HttpResponse.json({
                id: "con_github_1",
                orgId: "org_acme",
                appSlug: "ctxpipe",
                installationId: 1,
                accountSlug: "acme",
                ingestAllRepositories: body.ingestAllRepositories,
                includeFutureRepos: body.includeFutureRepos,
                ingestionRepositoryCount: alreadyIndexed.length,
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              })
            },
          ),
        ],
      },
    },
  },
}
