import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { conversationsListHandler } from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceNavRow } from "./WorkspaceNavRow"
import {
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/NavRow",
  component: WorkspaceNavRow,
  decorators: [
    (Story) => (
      <ul className="w-64 bg-zinc-950 py-2">
        <Story />
      </ul>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
    workspaceCount: 2,
    navExpanded: true,
    collapsible: true,
    open: false,
    current: false,
    onToggle: fn(),
    onExpand: fn(),
    onSelectNav: fn(),
  },
} satisfies Meta<typeof WorkspaceNavRow>

export default meta

type Story = StoryObj<typeof meta>

export const MultipleWorkspaces: Story = {
  render: (args) => (
    <>
      <WorkspaceNavRow {...args} current />
      <WorkspaceNavRow
        {...args}
        workspace={readOnlyWorkspace}
        current={false}
      />
    </>
  ),
}

export const SingleWorkspace: Story = {
  args: {
    workspaceCount: 1,
    collapsible: false,
    current: true,
  },
}

export const CollapsedNav: Story = {
  args: {
    navExpanded: false,
    current: true,
  },
}

export const OpenWithConversations: Story = {
  args: {
    open: true,
    current: true,
    currentConversationId: "conv_1",
  },
  parameters: {
    msw: {
      handlers: {
        page: [conversationsListHandler(docsConversations)],
      },
    },
  },
}

const ingestingDocs = {
  ingestion: workspaceIngestionHandlers({
    docs: [
      ingestionItemFixture(),
      ingestionItemFixture({
        id: "run_linear",
        kind: "source_sync",
        name: "Linear",
        stage: "syncing",
        progress: null,
      }),
    ],
  }),
}

const idleReads: string[] = []

/** No Workspace ingests: no pulse, and the row names only the Workspace. */
export const NotIngesting: Story = {
  parameters: {
    msw: { handlers: { ingestion: workspaceIngestionHandlers({}, idleReads) } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", { name: "Open Docs" })
    await waitFor(() => expect(idleReads.length).toBeGreaterThan(0))
    await expect(
      canvasElement.querySelector("[data-ingesting]"),
    ).not.toBeInTheDocument()
  },
}

/**
 * The Workspace ingests two sources: a teal pulse after the name, and the
 * text "Ingesting 2 sources" in a tooltip and in the row name (CTX-959).
 */
export const Ingesting: Story = {
  parameters: { msw: { handlers: ingestingDocs } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Open Docs. Ingesting 2 sources",
    })
    const dot = await waitFor(() => {
      const found = row.querySelector<HTMLElement>("[data-ingesting] > span")
      expect(found).not.toBeNull()
      return found as HTMLElement
    })
    await expect(getComputedStyle(dot).animationName).toBe("ctx-status-pulse")
    await userEvent.hover(dot)
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText(
          "Ingesting 2 sources",
        ),
      ).toBeVisible(),
    )
  },
}

/** With reduced motion the dot stays, but it does not pulse. */
export const IngestingReducedMotion: Story = {
  tags: ["reduced-motion"],
  parameters: { msw: { handlers: ingestingDocs } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Open Docs. Ingesting 2 sources",
    })
    await waitFor(() => {
      const dot = row.querySelector<HTMLElement>("[data-ingesting] > span")
      expect(dot).not.toBeNull()
      if (!dot) return
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
      // The CI runner emulates reduced motion for this tag.
      expect(getComputedStyle(dot).animationName).toBe(
        reduced ? "none" : "ctx-status-pulse",
      )
    })
  },
}

/** In the collapsed sidebar the dot sits on the folder icon; the row tooltip gives the text. */
export const IngestingCollapsed: Story = {
  args: { navExpanded: false, current: true },
  parameters: { msw: { handlers: ingestingDocs } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Collapse Docs. Ingesting 2 sources",
    })
    await waitFor(() =>
      expect(row.querySelector("[data-ingesting]")).not.toBeNull(),
    )
    await userEvent.hover(row)
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText(
          "Docs: Ingesting 2 sources",
        ),
      ).toBeVisible(),
    )
  },
}
