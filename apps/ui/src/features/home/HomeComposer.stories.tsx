import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"

import {
  docsWorkspace,
  docsWorkspaceDetail,
  readOnlyWorkspace,
  readOnlyWorkspaceDetail,
} from "@/features/workspaces/workspace-fixtures"
import { signedInHandlers } from "@/mocks/handlers"
import { workspaceDetailHandler } from "@/mocks/workspace-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { HomeComposer } from "./HomeComposer"

const meta = {
  title: "Components/Home/Composer",
  component: HomeComposer,
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
      },
    },
    app: "root",
    queryClient: true,
    review: { kind: "component" },
    layout: "padded",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspaces: [docsWorkspace, readOnlyWorkspace],
    selected: docsWorkspace,
    onSelectWorkspace: () => undefined,
  },
} satisfies Meta<typeof HomeComposer>

export default meta

type Story = StoryObj<typeof meta>

export const WithWorkspaces: Story = {
  parameters: {
    review: {
      purpose:
        "Org home composer, where a member asks a question in a Workspace: the Workspace menu is open with two Workspaces.",
    },
    // Each item of the open menu preloads its Workspace.
    msw: {
      handlers: {
        page: [
          workspaceDetailHandler(docsWorkspaceDetail, "docs"),
          workspaceDetailHandler(readOnlyWorkspaceDetail, "handbook"),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByLabelText("Select workspace"))
    const page = within(canvasElement.ownerDocument.body)
    // React Aria names the menu by its trigger (aria-labelledby wins over aria-label).
    const menu = await page.findByRole("menu", { name: "Select workspace" })
    expect(menu.className).toMatch(/rounded-md/)
  },
}

export const NoWorkspaces: Story = {
  parameters: {
    review: {
      purpose:
        "Org home composer, where a member asks a question in a Workspace: the org has no Workspaces yet.",
    },
  },
  args: {
    workspaces: [],
    selected: null,
  },
}
