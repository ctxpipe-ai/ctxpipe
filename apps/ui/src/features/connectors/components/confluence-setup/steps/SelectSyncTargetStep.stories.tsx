import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { SelectSyncTargetStep } from "./SelectSyncTargetStep"

const orgSlug = "acme"
const atlassianConnectionId = "sync_target_conn"

const searchPayload = {
  repositories: [
    {
      id: 101,
      full_name: "acme/confluence-target",
      html_url: "https://github.com/acme/confluence-target",
      clone_url: "https://github.com/acme/confluence-target.git",
      name: "confluence-target",
      default_branch: "main",
    },
  ],
  repositorySelection: "selected",
  hasMore: false,
}

const meta = {
  title: "Components/Connections/Atlassian/Steps/SelectSyncTarget",
  component: SelectSyncTargetStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof SelectSyncTargetStep>

export default meta

type Story = StoryObj<typeof meta>

const wrap = (node: ReactNode) => (
  <div className="w-full max-w-md p-4 text-left">{node}</div>
)

export const LoadingRepos: Story = {
  name: "LoadingRepos",
  render: () =>
    wrap(
      <SelectSyncTargetStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/repositories`,
            async () => {
              await delay("infinite")
              return HttpResponse.json({ items: [] })
            },
          ),
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/atlassian/config")) return false
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () => new HttpResponse(null, { status: 409 }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "installation/repositories",
              ),
            () => HttpResponse.json(searchPayload),
          ),
        ],
      },
    },
  },
}

export const Ready: Story = {
  name: "Ready",
  render: () =>
    wrap(
      <SelectSyncTargetStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              `/${orgSlug}/api/v1/repositories`,
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_101",
                    name: "confluence-target",
                    gitUrl: "https://github.com/acme/confluence-target.git",
                  },
                ],
              }),
          ),
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/atlassian/config")) return false
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () => new HttpResponse(null, { status: 409 }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "installation/repositories",
              ),
            () => HttpResponse.json(searchPayload),
          ),
          http.patch(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/atlassian/config")) return false
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () =>
              HttpResponse.json({
                accepted: true,
                savedCount: 1,
                configPrEnqueued: false,
              }),
          ),
        ],
      },
    },
  },
}
