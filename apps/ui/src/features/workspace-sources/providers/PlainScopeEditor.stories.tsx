import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { plainCatalogHandler } from "@/mocks/plain-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import preview from "../../../../.storybook/preview"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { PlainScopeEditor } from "./plain"

const catalogPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith("/api/v1/connectors/plain/catalog")

const meta = preview.meta({
  title: "Components/WorkspaceSources/PlainScopeEditor",
  component: PlainScopeEditor,
  decorators: [sourceDialogStoryFrame],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, plainCatalogHandler)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    provider: "plain",
    connectionId: "con_plain1",
    initialScope: {},
    onChange: fn(),
  },
})

/**
 * Plain scope editor, where the user picks the Help Centers and labels of a
 * Workspace source: nothing is picked at first, with notes on limits and
 * personal data, then the user picks two items.
 */
export const SelectHelpCentersAndLabels = meta.story({
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByText("Select at least one Help Center or label."),
      ).toBeVisible(),
    )
    await expect(args.onChange).not.toHaveBeenCalled()
    await expect(canvas.getByText(/100 newest threads/)).toBeVisible()
    await expect(canvas.getByText(/can hold personal data/)).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Product docs" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "Bug" }))
    await expect(args.onChange).toHaveBeenLastCalledWith({
      helpCenters: ["hc_docs"],
      labels: ["lt_bug"],
    })
  },
})

/**
 * Plain scope editor in the Add source dialog: Product docs is selected, the
 * user filters for feat and ticks Feature request, and Product docs stays in
 * the list as selected.
 */
export const FilterKeepsTheSelection = meta.story({
  args: { label: "Support", initialScope: { helpCenters: ["hc_docs"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: "Product docs" }),
      ).toBeChecked(),
    )
    await userEvent.type(
      canvas.getByRole("searchbox", {
        name: "Filter Plain Help Centers and labels for Support",
      }),
      "feat",
    )
    await expect(canvas.queryByRole("checkbox", { name: "Bug" })).toBeNull()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Feature request" }),
    )
    // The filter hides "Product docs", but a selected item stays in the list.
    await expect(
      canvas.getByRole("checkbox", { name: "Product docs" }),
    ).toBeChecked()
    await expect(args.onChange).toHaveBeenLastCalledWith({
      helpCenters: ["hc_docs"],
      labels: ["lt_feature"],
    })
  },
})

/**
 * Plain scope editor, where the user picks the Help Centers and labels of a
 * Workspace source: a selected label that Plain no longer lists shows by its
 * id, and the user clears it.
 */
export const RemovedItemCanBeCleared = meta.story({
  args: { initialScope: { labels: ["lt_gone", "lt_bug"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected id that Plain no longer lists shows by its id.
    const old = await canvas.findByRole("checkbox", { name: "Label lt_gone" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(args.onChange).toHaveBeenLastCalledWith({ labels: ["lt_bug"] })
  },
})

/**
 * Plain scope editor, where the user picks the Help Centers and labels of a
 * Workspace source: the Help Centers and labels still load.
 */
export const Loading = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByText("Loading Plain Help Centers and labels"),
    ).toBeInTheDocument()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(catalogPath, async () => {
        await delay("infinite")
        return HttpResponse.json({})
      }),
    )
  },
})

/**
 * Plain scope editor in the Add source dialog: Plain refuses the API key of the
 * connection, so an error alert in place of the list tells the user to
 * reconnect Plain.
 */
export const LoadError = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText(/Reconnect Plain/)).toBeVisible(),
    )
    // The error is the one message: no hint asks for a selection.
    await expect(
      canvas.queryByText("Select at least one Help Center or label."),
    ).toBeNull()
  },
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(catalogPath, () =>
        HttpResponse.json(
          {
            error:
              "Plain does not accept the API key of this connection. Reconnect Plain.",
          },
          { status: 400 },
        ),
      ),
    )
  },
})
