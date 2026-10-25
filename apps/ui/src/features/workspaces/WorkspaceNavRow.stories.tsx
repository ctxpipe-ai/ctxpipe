import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { conversationsListHandler } from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "./workspace-fixtures"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

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
        stage: null,
        progress: null,
      }),
    ],
  }),
}

/**
 * Docs does not ingest: no pulse, and the row names only the Workspace. The
 * other row ingests, so the play knows that the read is applied.
 */
export const NotIngesting: Story = {
  render: (args) => (
    <>
      <WorkspaceNavRow {...args} />
      <WorkspaceNavRow {...args} workspace={readOnlyWorkspace} />
    </>
  ),
  parameters: {
    msw: {
      handlers: {
        ingestion: workspaceIngestionHandlers({
          handbook: [ingestionItemFixture()],
        }),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", {
      name: "Open Handbook. Ingesting 1 source",
    })
    await waitFor(() => {
      const docs = canvas.getByRole("link", { name: "Open Docs" })
      expect(docs.querySelector("[data-ingesting]")).not.toBeInTheDocument()
    })
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
      expect(getComputedStyle(found as HTMLElement).animationName).toBe(
        "ctx-status-pulse",
      )
      return found as HTMLElement
    })
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

/**
 * With reduced motion the dot stays, but it does not pulse. The golden
 * runner opens this story with `prefers-reduced-motion: reduce`.
 */
export const IngestingReducedMotion: Story = {
  tags: ["workspace-golden", "reduced-motion"],
  parameters: { msw: { handlers: ingestingDocs } },
  play: async ({ canvasElement }) => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
      true,
    )
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Open Docs. Ingesting 2 sources",
    })
    await waitFor(() => {
      const dot = row.querySelector<HTMLElement>("[data-ingesting] > span")
      expect(dot).not.toBeNull()
      expect(getComputedStyle(dot as HTMLElement).animationName).toBe("none")
    })
  },
}

/** In the collapsed sidebar the dot sits on the folder icon; the row tooltip gives the text. */
export const IngestingCollapsed: Story = {
  args: { navExpanded: false, current: true },
  parameters: { msw: { handlers: ingestingDocs } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("button", {
      name: "Expand Docs. Ingesting 2 sources",
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
