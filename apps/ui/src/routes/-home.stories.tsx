import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import { githubInstallationNoneHandler } from "@/mocks/handlers"
import { orgPageDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const meta = {
  title: "Pages/Home",
  decorators: orgPageDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.getByText("Loading home")).toBeInTheDocument()
  },
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
        ],
      },
    },
  },
}

export const Start: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [githubInstallationNoneHandler],
      },
    },
  },
}

export const IndexingRepositories: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              "/acme/api/v1/github/installation",
            () =>
              HttpResponse.json({
                id: "github_connection_1",
                appSlug: "ctxpipe",
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname === "/acme/api/v1/repositories",
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_1",
                    name: "acme/web",
                    gitUrl: "https://github.com/acme/web.git",
                    indexReady: false,
                    indexingStatus: "running",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                  {
                    id: "repo_2",
                    name: "acme/api",
                    gitUrl: "https://github.com/acme/api.git",
                    indexReady: false,
                    indexingStatus: "queued",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                  {
                    id: "repo_3",
                    name: "acme/docs",
                    gitUrl: "https://github.com/acme/docs.git",
                    indexReady: true,
                    indexingStatus: "ready",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                ],
              }),
          ),
        ],
      },
    },
  },
}

export const IndexingSingleRepoWithStepLabel: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              "/acme/api/v1/github/installation",
            () =>
              HttpResponse.json({
                id: "github_connection_1",
                appSlug: "ctxpipe",
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname === "/acme/api/v1/repositories",
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_1",
                    name: "acme/web",
                    gitUrl: "https://github.com/acme/web.git",
                    indexReady: false,
                    indexingStatus: "running",
                    indexingStep: 7,
                    indexingStepTotal: 22,
                    indexingStepKey: "embedding",
                  },
                  {
                    id: "repo_2",
                    name: "acme/docs",
                    gitUrl: "https://github.com/acme/docs.git",
                    indexReady: true,
                    indexingStatus: "ready",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                ],
              }),
          ),
        ],
      },
    },
  },
}
