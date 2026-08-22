import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  conversationDetailLoadingHandler,
  githubInstallationReposHandler,
  workspaceDetailErrorHandler,
  workspaceDetailLoadingHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { orgPageDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceSurface } from "./WorkspaceSurface"
import {
  docsWorkspace,
  failedHydrateWorkspace,
  failedHydrateWorkspaceDetail,
  hydratingWorkspaceDetail,
  readOnlyWorkspace,
  waitingForTipWorkspaceDetail,
} from "./workspace-fixtures"

const orgSlug = "acme"
const workspaceSlug = "docs"

const meta = {
  title: "Pages/Workspaces",
  component: WorkspaceSurface,
  decorators: orgPageDecorators,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    orgSlug,
    workspaceSlug,
  },
} satisfies Meta<typeof WorkspaceSurface>

export default meta

type Story = StoryObj<typeof meta>

function workspaceRoute(input?: {
  conversationId?: string
  pane?: string
}): StoryRouteParams {
  return {
    pattern: "orgWorkspace",
    orgSlug,
    workspaceSlug,
    conversationId: input?.conversationId,
    pane: input?.pane,
  }
}

export const Loading: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [workspaceDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.getByText("Loading workspace")).toBeInTheDocument()
  },
}

export const NotFound: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: workspaceShellHandlers({ detail: null }),
      },
    },
  },
}

export const LoadError: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: [workspaceDetailErrorHandler(), ...workspaceShellHandlers()],
      },
    },
  },
}

export const Hydrating: Story = {
  args: { workspaceSlug: "knowledge" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [hydratingWorkspaceDetail, docsWorkspace],
          detail: hydratingWorkspaceDetail,
        }),
      },
    },
  },
}

export const WaitingForTip: Story = {
  args: { workspaceSlug: "waiting-tip" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "waiting-tip",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [waitingForTipWorkspaceDetail, docsWorkspace],
          detail: waitingForTipWorkspaceDetail,
        }),
      },
    },
  },
}

export const PrepareFailed: Story = {
  args: { workspaceSlug: "knowledge-failed" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "knowledge-failed",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/retry-prepare$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...failedHydrateWorkspace,
                hydrateStatus: "pending",
                hydrateError: null,
              }),
          ),
          ...workspaceShellHandlers({
            workspaces: [failedHydrateWorkspace, docsWorkspace],
            detail: failedHydrateWorkspaceDetail,
          }),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const Compose: Story = {
  parameters: {
    storyRoute: workspaceRoute(),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const Conversation: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const ConversationLoading: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_1" }),
    msw: {
      handlers: {
        page: [conversationDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: "Workspace files" })
    expect(
      canvas.getByRole("navigation", { name: "Main navigation" }),
    ).toBeVisible()
    expect(canvas.queryByText("Loading workspace")).not.toBeInTheDocument()
  },
}

export const ComposeThreadKeepsFiles: Story = {
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: "Workspace files" })
    await userEvent.click(canvas.getByRole("link", { name: "Repo layout" }))
    await waitFor(() => {
      expect(canvas.getByText("How is billing structured?")).toBeInTheDocument()
    })
    expect(canvas.getByRole("list", { name: "Workspace files" })).toBeVisible()
    await userEvent.click(
      canvas.getByRole("link", { name: "New conversation in Docs" }),
    )
    await waitFor(() => {
      expect(canvas.getByText("Ask about this Workspace.")).toBeInTheDocument()
    })
    expect(canvas.getByRole("list", { name: "Workspace files" })).toBeVisible()
    expect(canvas.queryByText("Loading workspace")).not.toBeInTheDocument()
  },
}

export const ConversationMissing: Story = {
  args: { conversationId: "conv_missing" },
  parameters: {
    storyRoute: workspaceRoute({ conversationId: "conv_missing" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers({ conversation: null }),
      },
    },
  },
}

export const FilesPane: Story = {
  args: { paneParam: "files" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "files" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const GraphPane: Story = {
  args: { paneParam: "graph" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "graph" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const SettingsPane: Story = {
  args: { paneParam: "settings" },
  parameters: {
    storyRoute: workspaceRoute({ pane: "settings" }),
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [docsWorkspace, readOnlyWorkspace],
        }),
      },
    },
  },
}

export const ReadOnly: Story = {
  args: { workspaceSlug: "handbook" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug,
      workspaceSlug: "handbook",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers({
          workspaces: [docsWorkspace, readOnlyWorkspace],
          detail: { ...readOnlyWorkspace, linkedRepositories: [] },
        }),
      },
    },
  },
}
