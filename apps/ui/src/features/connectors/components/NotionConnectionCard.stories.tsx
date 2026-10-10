import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import type { ReactNode } from "react"
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { notionOauthAppHandler } from "../mocks/notion-oauth-app-msw"
import { NotionConnectionCard } from "./NotionConnectionCard"

const orgSlug = "acme"
const connectionId = "con_story_notion"

const statusComplete = {
  isInstalled: true,
  installationStatus: "installed",
  workspaceName: "Acme",
  isGithubLinked: true,
  selectedResourceCount: null,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "repo_1",
    repositoryName: "acme/context",
    branch: "main",
  },
}

function notionStatus(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/notion/status")) return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(status),
  )
}

const meta = {
  title: "Components/Connections/NotionCard",
  component: NotionConnectionCard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof NotionConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

const shell = (story: ReactNode) => <div className="max-w-xl p-6">{story}</div>

const onOpenSetup = fn()

function card() {
  return (
    <NotionConnectionCard
      orgSlug={orgSlug}
      connectionId={connectionId}
      onOpenSetup={onOpenSetup}
    />
  )
}

export const Connected: Story = {
  render: () => shell(card()),
  parameters: {
    msw: { handlers: { page: [notionStatus(statusComplete)] } },
  },
}

export const Checking: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            async () => {
              await delay("infinite")
              return HttpResponse.json(statusComplete)
            },
          ),
        ],
      },
    },
  },
}

export const CouldntLoad: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.includes(
                "/api/v1/connectors/notion/status",
              ),
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

export const PendingSetup: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus({
            isInstalled: false,
            installationStatus: null,
            workspaceName: null,
            isGithubLinked: false,
            selectedResourceCount: 0,
            syncTargetConfigured: false,
            setupPhase: "draft",
            pendingConfigPullUrl: null,
            pendingConfigPrCreating: false,
            syncTarget: null,
          }),
          notionOauthAppHandler({
            orgSlug,
            connectionId,
            oauthAppSaved: false,
            globalNotionOAuthConfigured: false,
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    onOpenSetup.mockClear()
    const canvas = within(canvasElement)
    await canvas.findByText("Setup not finished")
    await userEvent.click(
      canvas.getByRole("button", { name: "Continue setup" }),
    )
    expect(onOpenSetup).toHaveBeenCalledWith(false)
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }))
    const dialog = await screen.findByRole("alertdialog")
    await within(dialog).findByText("Remove this Notion setup?")
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: "Remove setup" }),
      ).toBeVisible(),
    )
  },
}

export const SyncFailed: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [notionStatus({ ...statusComplete, setupPhase: "sync_failed" })],
      },
    },
  },
}

export const ConfigurationPullRequestFailed: Story = {
  render: () => shell(card()),
  parameters: {
    msw: {
      handlers: {
        page: [
          notionStatus({ ...statusComplete, setupPhase: "config_failed" }),
        ],
      },
    },
  },
}
