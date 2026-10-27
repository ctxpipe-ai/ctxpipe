import type { Meta, StoryObj } from "@storybook/react-vite"
import { ZENDESK_SOURCE_MAX_ITEMS } from "backend/domain/workspace-sources/providers/zendesk"
import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { zendeskCatalogHandler } from "@/mocks/zendesk-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ZendeskScopeEditor } from "./zendesk"

/** The editor with the scope it reports, as the Choose Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <ZendeskScopeEditor
        orgSlug="acme"
        provider="zendesk"
        connectionId="con_zendesk1"
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
  new URL(request.url).pathname.endsWith("/api/v1/connectors/zendesk/catalog")

const meta = {
  title: "Components/WorkspaceSources/ZendeskScopeEditor",
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
    msw: { handlers: { page: [zendeskCatalogHandler] } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectCategoriesAndViews: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("Not ready")).toBeVisible())
    await expect(
      canvas.getByText("Select at least one category or view."),
    ).toBeVisible()
    await expect(canvas.getByText(/syncs once a day/)).toBeVisible()
    await expect(canvas.getByText(/can hold personal data/)).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "Accounts" }),
    )
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "Escalated to engineering" }),
    )
    await expect(
      canvas.getByText(
        JSON.stringify({ categories: ["360001"], views: ["900001"] }),
      ),
    ).toBeVisible()
  },
}

export const FilterKeepsTheSelection: Story = {
  args: { label: "Support", initialScope: { categories: ["360001"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByRole("checkbox", { name: "Accounts" })).toBeChecked(),
    )
    await userEvent.type(
      canvas.getByRole("searchbox", {
        name: "Filter Zendesk categories and views for Support",
      }),
      "bug",
    )
    await expect(canvas.queryByRole("checkbox", { name: "Billing" })).toBeNull()
    await userEvent.click(canvas.getByRole("checkbox", { name: "Bugs" }))
    // The filter hides "Accounts", but a selected item stays in the list.
    await expect(
      canvas.getByRole("checkbox", { name: "Accounts" }),
    ).toBeChecked()
    await expect(
      canvas.getByText(
        JSON.stringify({ categories: ["360001"], views: ["900002"] }),
      ),
    ).toBeVisible()
  },
}

export const RemovedItemCanBeCleared: Story = {
  args: { initialScope: { views: ["999999", "900002"] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    // A selected id that Zendesk no longer lists shows by its id.
    const old = await canvas.findByRole("checkbox", { name: "View 999999" })
    await expect(old).toBeChecked()
    await userEvent.click(old)
    await expect(
      canvas.getByText(JSON.stringify({ views: ["900002"] })),
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
      await canvas.findByText("Loading Zendesk categories and views"),
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
                  "Zendesk does not accept the authorization of this connection. Reconnect Zendesk.",
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
      expect(canvas.getByText(/Reconnect Zendesk/)).toBeVisible(),
    )
  },
}

export const OverTheViewLimit: Story = {
  args: {
    // A full selection: one more view goes above the cap.
    initialScope: {
      views: Array.from({ length: ZENDESK_SOURCE_MAX_ITEMS }, (_, i) =>
        String(800000 + i),
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const limit = `Select at most ${ZENDESK_SOURCE_MAX_ITEMS} Zendesk views.`
    const bugs = await canvas.findByRole("checkbox", { name: "Bugs" })
    await expect(canvas.queryByText(limit)).not.toBeInTheDocument()
    await userEvent.click(bugs)
    await waitFor(() => expect(canvas.getByText(limit)).toBeVisible())
    await expect(canvas.getByText("Not ready")).toBeVisible()
    // One view less is in the cap again, and the scope is ready.
    await userEvent.click(canvas.getByRole("checkbox", { name: "Bugs" }))
    await waitFor(() =>
      expect(canvas.getByText(/^\{"views":\["800000",/)).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.queryByText(limit)).not.toBeInTheDocument(),
    )
  },
}
