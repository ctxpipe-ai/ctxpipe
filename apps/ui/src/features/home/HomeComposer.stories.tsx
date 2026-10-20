import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { HomeComposer } from "./HomeComposer"

const meta = {
  title: "Components/Home/Composer",
  component: HomeComposer,
  decorators: entryPageInnerDecorators,
  parameters: {
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
  args: {
    workspaces: [],
    selected: null,
  },
}
