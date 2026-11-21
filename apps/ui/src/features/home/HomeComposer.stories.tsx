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
import preview from "../../../.storybook/preview"
import { HomeComposer } from "./HomeComposer"

const meta = preview.meta({
  title: "Components/Home/Composer",
  component: HomeComposer,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, pendingWorkspaceUpgradesHandler({}))
  },
  parameters: {
    app: "root",
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
})

/**
 * Org home composer, where a member asks a question in a Workspace: the
 * Workspace menu is open with two Workspaces.
 */
export const WithWorkspaces = meta.story({
  beforeEach: ({ msw }) => {
    // Each item of the open menu preloads its Workspace.
    msw.use(
      workspaceDetailHandler(docsWorkspaceDetail, "docs"),
      workspaceDetailHandler(readOnlyWorkspaceDetail, "handbook"),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByLabelText("Select workspace"))
    const page = within(canvasElement.ownerDocument.body)
    // React Aria names the menu by its trigger (aria-labelledby wins over aria-label).
    const menu = await page.findByRole("menu", { name: "Select workspace" })
    expect(menu.className).toMatch(/rounded-md/)
  },
})

/**
 * Org home composer, where a member asks a question in a Workspace: the org has
 * no Workspaces yet.
 */
export const NoWorkspaces = meta.story({
  args: {
    workspaces: [],
    selected: null,
  },
})
