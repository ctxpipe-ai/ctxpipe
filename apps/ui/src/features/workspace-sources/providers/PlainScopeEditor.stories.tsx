import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { plainCatalogHandler } from "@/mocks/plain-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PlainScopeEditor } from "./plain"

/** The editor with the scope it reports, as the Choose Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <PlainScopeEditor
        orgSlug="acme"
        provider="plain"
        connectionId="con_plain1"
        initialScope={props.initialScope}
        label={props.label}
        onChange={setScope}
      />
      <output className="mt-4 block text-xs text-muted-foreground">
        {scope ? JSON.stringify(scope) : "Not ready"}
      </output>
    </>
  )
}

const catalogPath = ({ request }: { request: Request }) =>
  new URL(request.url).pathname.endsWith("/api/v1/connectors/plain/catalog")

const meta = {
  title: "Components/WorkspaceSources/PlainScopeEditor",
  component: EditorWithOutput,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: [plainCatalogHandler] } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectHelpCentersAndLabels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(await canvas.findByText("Not ready")).toBeVisible()
    await expect(
      canvas.getByText("Select at least one Help Center or label."),
    ).toBeVisible()
    await expect(canvas.getByText(/100 newest threads/)).toBeVisible()
    await expect(canvas.getByText(/can hold personal data/)).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Product docs" }),
    )
    await userEvent.click(canvas.getByRole("checkbox", { name: "Bug" }))
    await expect(
      canvas.getByText(
        JSON.stringify({ helpCenters: ["hc_docs"], labels: ["lt_bug"] }),
      ),
    ).toBeVisible()
  },
}

export const FilterKeepsTheSelection: Story = {
  args: { label: "Support", initialScope: { helpCenters: ["hc_docs"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await expect(
      await canvas.findByRole("checkbox", { name: "Product docs" }),
    ).toBeChecked()
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
    await expect(
      canvas.getByText(
        JSON.stringify({ helpCenters: ["hc_docs"], labels: ["lt_feature"] }),
      ),
    ).toBeVisible()
  },
}

export const RemovedItemCanBeCleared: Story = {
  args: { initialScope: { labels: ["lt_gone", "lt_bug"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected id that Plain no longer lists shows by its id.
    const old = await canvas.findByRole("checkbox", { name: "Label lt_gone" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(
      canvas.getByText(JSON.stringify({ labels: ["lt_bug"] })),
    ).toBeVisible()
  },
}

export const Loading: Story = {
  parameters: {
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
    await expect(await canvas.findByText(/Reconnect Plain/)).toBeVisible()
  },
}
