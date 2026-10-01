import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { docsWorkspace } from "@/features/workspaces/workspace-fixtures"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { SelectSyncTargetStep } from "./SelectSyncTargetStep"

const orgSlug = "acme"
const atlassianConnectionId = "sync_target_conn"

function isAtlassianConfig(request: Request) {
  const url = new URL(request.url)
  return (
    url.pathname.includes("/atlassian/config") &&
    url.searchParams.get("connectionId") === atlassianConnectionId
  )
}

const noConfigHandler = http.get(
  ({ request }) => isAtlassianConfig(request),
  () => new HttpResponse(null, { status: 409 }),
)

const savedBodies: unknown[] = []

const meta = {
  title: "Components/Connections/Atlassian/Steps/SelectSyncTarget",
  component: SelectSyncTargetStep,
  decorators: [
    (Story) => (
      <div className="w-full max-w-md p-4 text-left">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: { orgSlug, atlassianConnectionId },
} satisfies Meta<typeof SelectSyncTargetStep>

export default meta

type Story = StoryObj<typeof meta>

export const SelectSyncTarget: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          noConfigHandler,
          http.patch(
            ({ request }) => isAtlassianConfig(request),
            async ({ request }) => {
              savedBodies.push(await request.json())
              return HttpResponse.json({
                accepted: true,
                savedCount: 1,
                configPrEnqueued: true,
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    savedBodies.length = 0
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("combobox", { name: "Workspace" }),
    )
    await userEvent.click(
      await within(canvasElement.ownerDocument.body).findByRole("option", {
        name: docsWorkspace.displayName,
      }),
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Save workspace" }),
    )
    await waitFor(() =>
      expect(savedBodies).toEqual([
        {
          syncTarget: {
            repositoryName: "acme/docs",
            gitUrl: docsWorkspace.workspaceRepositoryUrl,
            branch: "main",
            enabled: true,
          },
        },
      ]),
    )
  },
}

export const NoWorkspaces: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceListHandler([]), noConfigHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("link", { name: "Create a workspace" }),
    ).toBeVisible()
  },
}

export const LoadingWorkspaces: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname),
            async () => {
              await delay("infinite")
              return HttpResponse.json({ items: [] })
            },
          ),
          noConfigHandler,
        ],
      },
    },
  },
}
