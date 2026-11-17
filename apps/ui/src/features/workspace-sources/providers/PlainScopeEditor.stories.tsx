import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { plainCatalogHandler } from "@/mocks/plain-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PlainScopeEditor } from "./plain"
import { scopeEditorStoryFrame } from "./scope-editor-story-frame"

const catalogPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith("/api/v1/connectors/plain/catalog")

const meta = {
  title: "Components/WorkspaceSources/PlainScopeEditor",
  component: PlainScopeEditor,
  decorators: [scopeEditorStoryFrame],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: { session: signedInHandlers, page: [plainCatalogHandler] },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "plain",
    connectionId: "con_plain1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof PlainScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

export const SelectHelpCentersAndLabels: Story = {
  parameters: {
    review: {
      purpose:
        "Plain scope editor, where the user picks the Help Centers and labels of a Workspace source: nothing is picked at first, with notes on limits and personal data, then the user picks two items.",
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByText("Select at least one Help Center or label."),
    ).toBeVisible()
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
}

export const FilterKeepsTheSelection: Story = {
  parameters: {
    review: {
      purpose:
        "Plain scope editor in the Add source dialog: Product docs is selected, the user filters for feat and ticks Feature request, and Product docs stays in the list as selected.",
    },
  },
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
}

export const RemovedItemCanBeCleared: Story = {
  parameters: {
    review: {
      purpose:
        "Plain scope editor, where the user picks the Help Centers and labels of a Workspace source: a selected label that Plain no longer lists shows by its id, and the user clears it.",
    },
  },
  args: { initialScope: { labels: ["lt_gone", "lt_bug"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected id that Plain no longer lists shows by its id.
    const old = await canvas.findByRole("checkbox", { name: "Label lt_gone" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(args.onChange).toHaveBeenLastCalledWith({ labels: ["lt_bug"] })
  },
}

export const Loading: Story = {
  parameters: {
    review: {
      purpose:
        "Plain scope editor, where the user picks the Help Centers and labels of a Workspace source: the Help Centers and labels still load.",
    },
    msw: {
      handlers: {
        page: [
          http.get(catalogPath, async () => {
            await delay("infinite")
            return HttpResponse.json({})
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByText("Loading Plain Help Centers and labels"),
    ).toBeInTheDocument()
  },
}

export const LoadError: Story = {
  parameters: {
    review: {
      purpose:
        "Plain scope editor in the Add source dialog: Plain refuses the API key of the connection, so an error alert in place of the list tells the user to reconnect Plain.",
    },
    msw: {
      handlers: {
        page: [
          http.get(catalogPath, () =>
            HttpResponse.json(
              {
                error:
                  "Plain does not accept the API key of this connection. Reconnect Plain.",
              },
              { status: 400 },
            ),
          ),
        ],
      },
    },
  },
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
}
