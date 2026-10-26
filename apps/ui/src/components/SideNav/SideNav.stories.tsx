import type { Meta, StoryObj } from "@storybook/react-vite"
import { Link } from "react-aria-components"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { AppShell } from "@/components/AppShell"
import { SideNav } from "@/components/SideNav"
import {
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import {
  conversationsListHandler,
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const meta = {
  title: "App/SideNav",
  component: SideNav,
  decorators: [
    (Story) => (
      <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
        <Story />
        <div className="flex-1 p-6 text-sm text-muted-foreground">
          Main content
        </div>
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof SideNav>

export default meta

type Story = StoryObj<typeof meta>

export const SingleWorkspace: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const MultipleWorkspaces: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const Collapsed: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /collapse navigation/i }),
    )
  },
}

/**
 * Proof for the global story reset. The story before this one collapses the
 * nav and stores that choice. This story must still start expanded.
 */
export const ExpandedAfterCollapsedStory: Story = {
  parameters: Collapsed.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: /collapse navigation/i })
    await expect(
      canvas.queryByRole("button", { name: /expand navigation/i }),
    ).not.toBeInTheDocument()
  },
}

/** A plain link (not a nav item) opens Connectors. The shell stays mounted, and
 * the current nav item moves from the Workspace to Connectors. */
export const PlainLinkMovesCurrentNav: Story = {
  tags: ["workspace-golden"],
  render: () => (
    <AppShell>
      <Link href="/acme/connectors" className="p-6 text-sm text-teal-400">
        Connect another source
      </Link>
    </AppShell>
  ),
  parameters: {
    intent:
      "Catches a plain link in the page that does not move the current item in the main navigation. Not for nav styling or workspace list data.",
    storyRoute: {
      pattern: "flat",
      path: "/acme/ws/docs",
      alsoAt: ["/acme/connectors"],
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = await canvas.findByRole("navigation", {
      name: "Main navigation",
    })
    const connectors = await within(nav).findByRole("link", {
      name: "Connectors",
    })
    await expect(connectors).not.toHaveAttribute("aria-current")
    await userEvent.click(
      canvas.getByRole("link", { name: "Connect another source" }),
    )
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Connectors" }),
      ).toHaveAttribute("aria-current", "page"),
    )
  },
}

export const DocsLinkOpensProductDocs: Story = {
  parameters: {
    ...SingleWorkspace.parameters,
    intent:
      "Catches a Docs link that is missing from the Help list of the main navigation. Also catches a Docs link that does not open the product docs in a new tab, or that has no name in the collapsed rail. Not for the other footer items.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = await canvas.findByRole("navigation", {
      name: "Main navigation",
    })
    const help = await within(nav).findByRole("list", { name: "Help" })
    const docs = within(help).getByRole("link", { name: "Docs" })
    await expect(docs).toHaveAttribute("href", "https://docs.ctxpipe.ai")
    await expect(docs).toHaveAttribute("target", "_blank")
    await userEvent.click(
      canvas.getByRole("button", { name: /collapse navigation/i }),
    )
    await within(nav).findByRole("button", { name: /expand navigation/i })
    await expect(
      within(nav).getByRole("link", { name: "Docs" }),
    ).toHaveAttribute("href", "https://docs.ctxpipe.ai")
  },
}

export const UserMenuLinksConnectedApps: Story = {
  tags: ["workspace-golden"],
  parameters: {
    ...SingleWorkspace.parameters,
    intent:
      "Catches a user menu whose Connected apps item does not link to the connected apps page in the auth area. Not for other menu items or account data.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: /User menu|User/ }),
    )
    const item = await body.findByRole("menuitem", { name: /Connected apps/ })
    await expect(item.closest("a")).toHaveAttribute(
      "href",
      "/.auth/account/connected-apps",
    )
  },
}
