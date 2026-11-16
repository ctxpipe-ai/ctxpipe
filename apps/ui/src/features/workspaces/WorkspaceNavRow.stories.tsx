import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import {
  conversationDetailHandler,
  conversationGitTreeHandler,
  conversationsListHandler,
  workspaceDetailHandler,
} from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  docsConversationDetail,
  docsConversations,
  docsWorkspace,
  docsWorkspaceDetail,
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
  ],
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        ingestion: workspaceIngestionHandlers({}),
      },
    },
    app: "root",
    review: { kind: "component" },
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
  parameters: {
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: two rows, the current Workspace and a read-only one.",
    },
  },
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
  parameters: {
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: the only Workspace of the org, current and not collapsible.",
    },
  },
  args: {
    workspaceCount: 1,
    collapsible: false,
    current: true,
  },
}

export const CollapsedNav: Story = {
  parameters: {
    review: {
      purpose:
        "Workspace row in the collapsed side nav rail, which opens a Workspace: the current Workspace as an icon with no name.",
    },
  },
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
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: the row is open and lists its chats, with the open chat selected.",
    },
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
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: the first row does not ingest, so it has no pulse, and the second row ingests.",
    },
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
  parameters: {
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: it ingests two sources, so a teal dot pulses and its tooltip is open.",
    },
    msw: {
      handlers: {
        ...ingestingDocs,
        // The hover preloads the Workspace and its last conversation.
        page: [
          workspaceDetailHandler(docsWorkspaceDetail),
          conversationDetailHandler(docsConversationDetail),
          conversationGitTreeHandler(),
        ],
      },
    },
  },
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
 * With reduced motion the dot stays, but it does not pulse. The play
 * runner opens this story with `prefers-reduced-motion: reduce`.
 */
export const IngestingReducedMotion: Story = {
  tags: ["required", "reduced-motion"],
  parameters: {
    review: {
      purpose:
        "Workspace row in the side nav, which opens a Workspace: it ingests two sources with reduced motion, so the dot does not pulse.",
    },
    intent:
      "Catches an ingesting dot in the workspace nav row that keeps animating when the user prefers reduced motion. The dot must not animate. Not for the row label or link.",
    msw: { handlers: ingestingDocs },
  },
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
  parameters: {
    review: {
      purpose:
        "Workspace row in the collapsed side nav rail: it ingests two sources, so a dot sits on the icon and the row tooltip is open.",
    },
    msw: { handlers: ingestingDocs },
  },
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
