import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { confluenceTreeHandlers } from "@/mocks/confluence-handlers"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConfluenceScopeEditor } from "./confluence"

const connectionId = "con_conf1"

/** The editor with the scope it reports, as the Choose Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <ConfluenceScopeEditor
        orgSlug="acme"
        provider="confluence"
        connectionId={connectionId}
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
  title: "Components/WorkspaceSources/ConfluenceScopeEditor",
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
    msw: { handlers: { page: confluenceTreeHandlers } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectAllPagesOfASpace: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The auth decorator renders the story after the session loads.
    await waitFor(() => expect(canvas.getByText("Not ready")).toBeVisible())
    await expect(canvas.getByText(/Select at least one space/)).toBeVisible()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /Engineering/ }),
    )
    await expect(
      canvas.getByText('{"spaces":[{"key":"ENG","pages":"all"}]}'),
    ).toBeVisible()
    await expect(canvas.queryByText(/Select at least one space/)).toBeNull()
  },
}

export const EditsASavedPageList: Story = {
  tags: ["workspace-golden"],
  args: {
    label: "Docs",
    initialScope: { spaces: [{ key: "OPS", pages: ["101"] }] },
  },
  play: async ({ canvasElement }) => {
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
    await expect(
      canvas.getByText('{"spaces":[{"key":"OPS","pages":"all"}]}'),
    ).toBeVisible()
  },
}
