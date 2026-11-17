import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { confluenceTreeHandlers } from "@/mocks/confluence-handlers"
import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { ConfluenceScopeEditor } from "./confluence"

const meta = {
  title: "Components/WorkspaceSources/ConfluenceScopeEditor",
  component: ConfluenceScopeEditor,
  decorators: [sourceDialogStoryFrame],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: { session: signedInHandlers, page: confluenceTreeHandlers },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "confluence",
    connectionId: "con_conf1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof ConfluenceScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Confluence scope editor in the Add source dialog, where the user picks the
 * spaces and pages that a Workspace source syncs: from an empty selection, the
 * user ticks the Engineering space.
 */
export const SelectAllPagesOfASpace: Story = {
  parameters: {
    intent:
      "Catches a Confluence scope that stays not ready after the user picks a space. Picking a space must select all its pages in the scope. Not for saved page lists.",
  },
  tags: ["required"],
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    // The auth decorator renders the story after the session loads.
    await waitFor(() =>
      expect(canvas.getByText(/Select at least one space/)).toBeVisible(),
    )
    await expect(args.onChange).not.toHaveBeenCalled()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith({
      spaces: [{ key: "ENG", pages: "all" }],
    })
    await expect(canvas.queryByText(/Select at least one space/)).toBeNull()
  },
}

/**
 * Confluence scope editor in the Edit source dialog: the saved scope had some
 * pages of the Operations space, and the user ticked the space, so the source
 * now syncs all its pages.
 */
export const EditsASavedPageList: Story = {
  parameters: {
    intent:
      "Catches a saved page list that shows its space as fully or not selected. A partial list shows as partly selected, and a click selects all pages. Not for a new scope.",
  },
  tags: ["required"],
  args: {
    label: "Docs",
    initialScope: { spaces: [{ key: "OPS", pages: ["101"] }] },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("region", { name: "Spaces and pages for Docs" }),
      ).toBeVisible(),
    )
    const operations = await canvas.findByRole("checkbox", {
      name: /Operations/,
    })
    // Some pages selected: the space shows as partly selected.
    await expect(operations).toBePartiallyChecked()
    await userEvent.click(operations)
    await expect(args.onChange).toHaveBeenLastCalledWith({
      spaces: [{ key: "OPS", pages: "all" }],
    })
  },
}
