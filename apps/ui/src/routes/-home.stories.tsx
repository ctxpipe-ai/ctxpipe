import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { githubInstallationNoneHandler } from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const meta = {
  title: "Pages/Home",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

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
