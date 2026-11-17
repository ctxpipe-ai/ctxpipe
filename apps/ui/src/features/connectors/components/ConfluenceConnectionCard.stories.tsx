import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test"

import { atlassianOauthHandler } from "@/mocks/atlassian-handlers"
import { signedInHandlers } from "@/mocks/handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  activeMemberRoleHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConfluenceConnectionCard } from "./ConfluenceConnectionCard"

const orgSlug = "acme"
const connectionId = "story_forge_conn"

const cardProps = {
  orgSlug,
  connectionId,
  onOpenWizard: () => {},
} as const

const statusNotLinked = {
  isLinked: false,
  isInstalled: false,
  installationStatus: null,
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  setupPhase: "draft",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: null,
  selectedSpaces: [] as { spaceKey: string; spaceName: string | null }[],
}

const statusComplete = {
  isLinked: true,
  isInstalled: true,
  installationStatus: "installed",
  isGithubLinked: true,
  selectedSpaceCount: 1,
  syncTargetConfigured: true,
  setupPhase: "live",
  pendingConfigPullUrl: null,
  pendingConfigPrCreating: false,
  syncTarget: {
    repositoryId: "r1",
    repositoryName: "acme/wiki",
    branch: "main",
  },
  selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
}

function atlassianStatus(status: object) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
        return false
      return u.searchParams.get("connectionId") === connectionId
    },
    () => HttpResponse.json(status),
  )
}

const meta = {
  title: "Components/Connections/Atlassian/ConnectionCard",
  component: ConfluenceConnectionCard,
  args: cardProps,
  decorators: [
    (Story) => (
      <div className="w-xl max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    app: "root",
    msw: {
      handlers: {
        session: signedInHandlers,
        role: [activeMemberRoleHandler("admin")],
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
        usage: [
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: "docs",
              workspaceName: "Docs",
            }),
          ]),
        ],
      },
    },
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof ConfluenceConnectionCard>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Confluence card on the Connectors page, collapsed: the Forge app is
 * installed, so the connection is live and the status is Connected.
 */
export const Connected: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianStatus(statusComplete),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    expect(canvas.queryByText("Setup not finished")).toBeNull()
    expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull()
    expect(
      canvas.getByRole("button", {
        name: "Confluence connector actions",
      }),
    ).toBeVisible()
  },
}

/** A live row is not a draft, also when this member has no Atlassian link. */
async function expectLiveRowNotPending(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await canvas.findByText("Needs reconnect")
  expect(canvas.queryByText("Setup not finished")).toBeNull()
  expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull()
  expect(
    canvas.getByRole("button", {
      name: "Confluence connector actions",
    }),
  ).toBeVisible()
}

/**
 * Confluence connection card on the Connectors page: the connection is live,
 * and the viewing member has no Atlassian link of their own.
 */
export const LiveViewerWithoutAtlassianLink: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Connected." },
    msw: {
      handlers: {
        page: [
          atlassianStatus({ ...statusComplete, isLinked: false }),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    expect(canvas.queryByText("Needs reconnect")).toBeNull()
    expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull()
    // The org connection is ready: a member needs no Atlassian link.
    expect(
      canvas.queryByRole("button", { name: /Link Atlassian account/ }),
    ).toBeNull()
  },
}

/**
 * Confluence connection card on the Connectors page: a live connection whose
 * Forge app was uninstalled, so it needs a reconnect.
 */
export const LiveForgeUninstalled: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianStatus({
            ...statusComplete,
            isInstalled: false,
            installationStatus: "uninstalled",
          }),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => expectLiveRowNotPending(canvasElement),
}

/**
 * Confluence connection card on the Connectors page: the status request has not
 * returned, so the card is still checking.
 */
export const Checking: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            async () => {
              await delay("infinite")
              return HttpResponse.json(statusNotLinked)
            },
          ),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
}

/**
 * Confluence card on the Connectors page: the status read failed, so a row
 * under the head gives the cause and a Retry button without a click.
 */
export const CouldntLoad: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
                return false
              return u.searchParams.get("connectionId") === connectionId
            },
            () => new HttpResponse(null, { status: 500 }),
          ),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
}

const onOpenWizard = fn()
const deletePendingSetup = fn()

/**
 * Confluence connection card on the Connectors page: setup is not finished, the
 * card is open with a Link Atlassian account action.
 */
export const PendingSetup: Story = {
  render: () => (
    <ConfluenceConnectionCard {...cardProps} onOpenWizard={onOpenWizard} />
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianStatus(statusNotLinked),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    onOpenWizard.mockClear()
    const canvas = within(canvasElement)
    await canvas.findByText("Setup not finished")
    expect(canvas.queryByText("Connected")).toBeNull()
    expect(
      canvas.getByRole("button", { name: "Remove Confluence setup" }),
    ).toBeVisible()
    const resume = canvas.getByRole("button", {
      name: "Link Atlassian account for Confluence",
    })
    expect(resume).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Confluence" }))
    await canvas.findByText("Account")
    expect(
      canvas.getAllByRole("button", { name: /Link Atlassian account/ }),
    ).toHaveLength(1)
    await userEvent.click(resume)
    expect(onOpenWizard).toHaveBeenCalledTimes(1)
  },
}

/**
 * Confluence connection card on the Connectors page: the user removes an
 * unfinished setup through a confirm dialog.
 */
export const RemovePendingSetup: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          atlassianStatus(statusNotLinked),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
          http.delete(
            ({ request }) => {
              const u = new URL(request.url)
              return (
                u.pathname.endsWith("/api/v1/connectors/atlassian") &&
                u.searchParams.get("connectionId") === connectionId
              )
            },
            () => {
              deletePendingSetup()
              return new HttpResponse(null, { status: 204 })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    deletePendingSetup.mockClear()
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", {
        name: "Remove Confluence setup",
      }),
    )
    const dialog = await screen.findByRole("alertdialog")
    await within(dialog).findByText("Remove this Confluence setup?")
    expect(deletePendingSetup).not.toHaveBeenCalled()
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove setup" }),
    )
    await waitFor(() => expect(deletePendingSetup).toHaveBeenCalledTimes(1))
  },
}

/**
 * Confluence connection card on the Connectors page: Confluence is connected
 * but in no Workspace yet. The card is open and offers Add to a Workspace. The
 * new connection holds only the auth, because each Workspace holds its own
 * scope (ADR-050).
 */
export const InstalledNotInWorkspaces: Story = {
  render: () => <ConfluenceConnectionCard {...cardProps} />,
  parameters: {
    msw: {
      handlers: {
        usage: [connectionUsageHandler([])],
        page: [
          atlassianStatus({
            ...statusNotLinked,
            isLinked: true,
            isInstalled: true,
            installationStatus: "installed",
          }),
          atlassianOauthHandler({ oauthAppSaved: true }, connectionId),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Connected")
    expect(canvas.queryByText("Setup not finished")).toBeNull()
    expect(canvas.queryByRole("button", { name: /for Confluence$/ })).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Confluence" }))
    await canvas.findByText("No Workspaces yet")
    // Each Workspace has its own scope, so the card shows none (ADR-050).
    await expect(canvas.queryAllByText("Scope")).toHaveLength(0)
    expect(
      canvas.getByRole("button", { name: "Add to a Workspace" }),
    ).toBeVisible()
  },
}
