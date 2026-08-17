import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import {
  workspaceFilesHandler,
  workspaceFilesLoadingHandler,
  workspaceGraphHandler,
  workspaceGraphLoadingHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspacePane } from "./WorkspacePane"
import {
  docsWorkspace,
  docsWorkspaceDetail,
  docsWorkspaceFiles,
} from "./workspace-fixtures"

const paneCallbacks = {
  onPane: fn(),
  onClose: fn(),
  onToggleMaximize: fn(),
  onRestoreConversation: fn(),
  onResize: fn(),
  onSelectFile: fn(),
  onOpenFileTab: fn(),
  onCloseFileTab: fn(),
  onToggleTree: fn(),
}

const meta = {
  title: "Components/Workspaces/Pane",
  component: WorkspacePane,
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] justify-end bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "files",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspaceDetail,
    pane: { kind: "files" },
    fileTabs: [],
    selectedFilePath: null,
    treeCollapsed: false,
    maximized: false,
    width: 420,
    conversationTitle: "Repo layout",
    ...paneCallbacks,
  },
} satisfies Meta<typeof WorkspacePane>

export default meta

type Story = StoryObj<typeof meta>

export const Files: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceFilesHandler()],
      },
    },
  },
}

export const FilesLoading: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceFilesLoadingHandler()],
      },
    },
  },
}

export const FilesEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [workspaceFilesHandler({ items: [], tree: [] })],
      },
    },
  },
}

export const FilePreview: Story = {
  args: {
    pane: { kind: "file", path: "knowledge/billing.md" },
    fileTabs: ["knowledge/billing.md"],
    selectedFilePath: "knowledge/billing.md",
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "file:knowledge%2Fbilling.md",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceFilesHandler(docsWorkspaceFiles)],
      },
    },
  },
}

export const Graph: Story = {
  args: { pane: { kind: "graph" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "graph",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceGraphHandler()],
      },
    },
  },
}

export const GraphLoading: Story = {
  args: { pane: { kind: "graph" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "graph",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceGraphLoadingHandler()],
      },
    },
  },
}

export const Settings: Story = {
  args: { pane: { kind: "settings" } },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "settings",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceListHandler([docsWorkspace])],
      },
    },
  },
}

export const Maximized: Story = {
  args: {
    pane: { kind: "files" },
    maximized: true,
  },
  parameters: {
    msw: {
      handlers: {
        page: [workspaceFilesHandler()],
      },
    },
  },
}
