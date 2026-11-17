import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { notionResourcesHandler } from "@/mocks/notion-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { NotionScopeEditor } from "./notion"

const HANDBOOK = "1a2b3c4d-0000-4000-8000-000000000001"
const INCIDENTS = "1a2b3c4d-0000-4000-8000-000000000002"

const meta = {
  title: "Components/WorkspaceSources/NotionScopeEditor",
  component: NotionScopeEditor,
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
      handlers: { session: signedInHandlers, page: [notionResourcesHandler] },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "notion",
    connectionId: "con_notion1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof NotionScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Notion scope editor in the Add source dialog, where the user picks the pages
 * and databases that a Workspace source syncs: the user ticks a page and a
 * database from the shared list.
 */
export const SelectAPageAndADatabase: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByText("Select at least one page or database."),
      ).toBeVisible(),
    )
    await expect(args.onChange).not.toHaveBeenCalled()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering handbook/ }),
    )
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /Incident log/ }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith({
      pages: [{ id: HANDBOOK, title: "Engineering handbook" }],
      databases: [{ id: INCIDENTS, title: "Incident log" }],
    })
  },
}

/**
 * Notion scope editor, where the user picks the pages and databases of a
 * Workspace source: a search hides a selected page, but it stays in the list
 * and stays selected.
 */
export const SearchKeepsTheSelection: Story = {
  args: {
    label: "Docs",
    initialScope: { pages: [{ id: HANDBOOK, title: "Engineering handbook" }] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: /Engineering handbook/ }),
      ).toBeChecked(),
    )
    await userEvent.type(
      canvas.getByRole("searchbox", { name: "Search Notion for Docs" }),
      "onboard",
    )
    // The list shows every page until the debounced search answers. Wait for
    // the answer (it drops the incident log), so the click and the end state
    // do not depend on when it arrives.
    await waitFor(() =>
      expect(
        canvas.queryByRole("checkbox", { name: /Incident log/ }),
      ).not.toBeInTheDocument(),
    )
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Onboarding/ }),
    )
    // The handbook is not in the results now. It stays in the list, selected,
    // as in the Linear picker. There is no separate list of pills.
    await expect(
      canvas.getByRole("checkbox", { name: /Engineering handbook/ }),
    ).toBeChecked()
    await expect(
      canvas.getByRole("checkbox", { name: /Onboarding/ }),
    ).toBeChecked()
    await expect(
      canvas.queryByRole("grid", { name: "Selected" }),
    ).not.toBeInTheDocument()
  },
}

/**
 * Notion scope editor, where the user picks the pages and databases of a
 * Workspace source: the user clears the last database, so the scope is not
 * ready.
 */
export const RemoveTheLastRoot: Story = {
  args: {
    initialScope: { databases: [{ id: INCIDENTS, title: "Incident log" }] },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Incident log/ }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
    await expect(
      canvas.getByText("Select at least one page or database."),
    ).toBeVisible()
  },
}

/**
 * Notion scope editor in the Add source dialog: the Notion search request
 * failed, so an error alert stands in place of the results, and the user can
 * search again.
 */
export const SearchFails: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/notion/available-resources",
              ),
            () => HttpResponse.json({ error: "Server error" }, { status: 500 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByText("Could not search Notion. Try again."),
      ).toBeVisible(),
    )
    // The error is the one message: no hint asks for a selection.
    await expect(
      canvas.queryByText("Select at least one page or database."),
    ).toBeNull()
  },
}
