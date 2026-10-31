import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { notionResourcesHandler } from "@/mocks/notion-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { NotionScopeEditor } from "./notion"

const HANDBOOK = "1a2b3c4d-0000-4000-8000-000000000001"
const INCIDENTS = "1a2b3c4d-0000-4000-8000-000000000002"

/** The editor with the scope it reports, as the Add to Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <NotionScopeEditor
        orgSlug="acme"
        provider="notion"
        connectionId="con_notion1"
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

const meta = {
  title: "Components/WorkspaceSources/NotionScopeEditor",
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
    msw: { handlers: { page: [notionResourcesHandler] } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectAPageAndADatabase: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("Not ready")).toBeVisible())
    await expect(
      canvas.getByText("Select at least one page or database."),
    ).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering handbook/ }),
    )
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /Incident log/ }),
    )
    await expect(
      canvas.getByText(
        JSON.stringify({
          pages: [{ id: HANDBOOK, title: "Engineering handbook" }],
          databases: [{ id: INCIDENTS, title: "Incident log" }],
        }),
      ),
    ).toBeVisible()
  },
}

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

export const RemoveTheLastRoot: Story = {
  args: {
    initialScope: { databases: [{ id: INCIDENTS, title: "Incident log" }] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Incident log/ }),
    )
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await expect(
      canvas.getByText("Select at least one page or database."),
    ).toBeVisible()
  },
}

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
  },
}
