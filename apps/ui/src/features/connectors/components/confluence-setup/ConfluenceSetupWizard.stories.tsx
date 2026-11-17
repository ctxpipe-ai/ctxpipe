import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  atlassianCapabilitiesHandler,
  atlassianOauthHandler,
  atlassianOauthSaveHandler,
} from "@/mocks/atlassian-handlers"
import { confluenceTreeHandlers } from "@/mocks/confluence-handlers"
import { signedInHandlers } from "@/mocks/handlers"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import {
  connectionUsageHandler,
  connectionUsageItem,
  workspaceSourceAddHandlers,
  workspaceSourceFixture,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import { pendingWorkspaceUpgradesHandler } from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../../../.storybook/decorators/with-story-route"
import { docsWorkspace } from "../../../workspaces/workspace-fixtures"
import type { AtlassianConnectorStatus } from "../../types"
import { ConfluenceSetupWizard } from "./ConfluenceSetupWizard"

const orgSlug = "acme"
const atlassianConnectionId = "con_forge_wizard"
const addCalls: { method: string; path: string; body: unknown }[] = []

function statusUrlMatches(request: Request, connectionId: string) {
  const u = new URL(request.url)
  if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
    return false
  }
  return u.searchParams.get("connectionId") === connectionId
}

const status = (s: AtlassianConnectorStatus) =>
  http.get(
    ({ request }) => statusUrlMatches(request, atlassianConnectionId),
    () => HttpResponse.json(s),
  )

/** For stories where the wizard is rendered *without* `connectionId` (no query param on the wire). */
const statusUnscoped = (s: AtlassianConnectorStatus) =>
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
        return false
      }
      return u.searchParams.get("connectionId") == null
    },
    () => HttpResponse.json(s),
  )

const installationPost = http.post(
  ({ request }) => {
    const u = new URL(request.url)
    return u.pathname === `/${orgSlug}/api/v1/connectors/atlassian/installation`
  },
  () => HttpResponse.json({ id: "install_intent_story" }),
)

const s0: AtlassianConnectorStatus = {
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
  selectedSpaces: [],
}

const sInstall: AtlassianConnectorStatus = {
  ...s0,
  isLinked: true,
  isInstalled: false,
  installationStatus: null,
}

/** Forge installed: the connection is ready; the scope is in each Workspace. */
const sInstalled: AtlassianConnectorStatus = {
  ...sInstall,
  isInstalled: true,
  installationStatus: "installed",
}

const wizard = (extra?: {
  initialWaitForInstall?: boolean
  atlassianConnectionId?: string
}) => {
  const id =
    extra != null && "atlassianConnectionId" in extra
      ? extra.atlassianConnectionId
      : atlassianConnectionId
  return (
    <ConfluenceSetupWizard
      orgSlug={orgSlug}
      atlassianConnectionId={id}
      isOpen
      onOpenChange={() => {}}
      initialWaitForInstall={extra?.initialWaitForInstall}
    />
  )
}

const meta = {
  title: "Components/Connections/Atlassian/SetupWizard",
  component: ConfluenceSetupWizard,
  args: {
    orgSlug,
    atlassianConnectionId,
    isOpen: true,
    onOpenChange: () => {},
  },
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        pendingUpgrades: [pendingWorkspaceUpgradesHandler({})],
      },
    },
    app: "root",
    layout: "fullscreen",
    docs: {
      description: {
        component: `
**End-to-end Confluence connection wizard.** Stories mock \`connectors/atlassian/status\`,
\`org/atlassian-oauth\`, and related endpoints so you can step through the same \`Modal\` shell as
production.

**Managed cloud:** the first step is **Link Atlassian account** (server-global OAuth app).

**Self-hosted:** the wizard adds **Register Atlassian OAuth app** until 3LO credentials are saved;
then **Link Atlassian account** and the rest match the managed flow.

Order (self-hosted): Register OAuth → Link Atlassian → Install Forge → optional wait → Add to
Workspaces (Workspaces, then spaces and pages) → complete.
        `.trim(),
      },
    },
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof ConfluenceSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * connection status is still loading.
 */
export const Loading: Story = {
  name: "01 / Loading",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => statusUrlMatches(request, atlassianConnectionId),
            async () => {
              await delay("infinite")
              return HttpResponse.json(s0)
            },
          ),
          atlassianOauthHandler(
            { oauthAppSaved: false },
            atlassianConnectionId,
          ),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * connection status request failed.
 */
export const StatusError: Story = {
  name: "02 / Status error",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => statusUrlMatches(request, atlassianConnectionId),
            () => new HttpResponse(null, { status: 500 }),
          ),
          atlassianOauthHandler(
            { oauthAppSaved: false },
            atlassianConnectionId,
          ),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard on a self-hosted deployment: the first step tells the
 * admin how to register an Atlassian OAuth app and asks for its Client ID and
 * secret.
 */
export const RegisterAtlassianOauth: Story = {
  name: "03 / Register Atlassian OAuth app (self-hosted)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(s0),
          atlassianOauthHandler(
            { oauthAppSaved: false },
            atlassianConnectionId,
          ),
          atlassianOauthSaveHandler(atlassianConnectionId),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * link step, with the org OAuth app saved so the user can sign in.
 */
export const LinkAtlassianSignIn: Story = {
  name: "03b / Link Atlassian (3LO saved — sign in)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(s0),
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
          atlassianOauthSaveHandler(atlassianConnectionId),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard on the hosted product, where ctxpipe supplies the
 * Atlassian OAuth app: the first step asks the admin to link an Atlassian
 * account.
 */
export const LinkAtlassianGlobalEnv: Story = {
  name: "03c / Link Atlassian (global env OAuth only)",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(s0),
          atlassianOauthHandler(
            {
              oauthAppSaved: false,
              globalAtlassianOAuthConfigured: true,
            },
            atlassianConnectionId,
          ),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * account is linked and the Forge app install step shows.
 */
export const InstallForge: Story = {
  name: "04 / Install Forge",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(sInstall),
          atlassianCapabilitiesHandler(
            "https://marketplace.atlassian.com/apps/123/ctxpipe",
            atlassianConnectionId,
          ),
          installationPost,
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
        ],
      },
    },
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * wizard waits for the Forge app install to finish.
 */
export const WaitForInstall: Story = {
  name: "05 / Wait for install",
  render: () => wizard({ initialWaitForInstall: true }),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(sInstall),
          atlassianCapabilitiesHandler(
            "https://marketplace.atlassian.com/apps/123/ctxpipe",
            atlassianConnectionId,
          ),
          installationPost,
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
        ],
      },
    },
  },
}

/** Each cancel request: the connection id it names. */
const cancelCalls: string[] = []
const installationDelete = http.delete(
  ({ request }) =>
    new URL(request.url).pathname ===
    `/${orgSlug}/api/v1/connectors/atlassian/installation`,
  ({ request }) => {
    cancelCalls.push(
      new URL(request.url).searchParams.get("connectionId") ?? "",
    )
    return new HttpResponse(null, { status: 204 })
  },
)
/** Each install intent: its `installOpened` query value. */
const intentCalls: (string | null)[] = []
const installationPostRecorded = http.post(
  ({ request }) =>
    new URL(request.url).pathname ===
    `/${orgSlug}/api/v1/connectors/atlassian/installation`,
  ({ request }) => {
    intentCalls.push(new URL(request.url).searchParams.get("installOpened"))
    return HttpResponse.json({ id: atlassianConnectionId })
  },
)
const installHandlers = [
  status(sInstall),
  atlassianCapabilitiesHandler(
    "https://marketplace.atlassian.com/apps/123/ctxpipe",
    atlassianConnectionId,
  ),
  installationPostRecorded,
  installationDelete,
  atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
]

/** Close: ask the server to delete the draft while it is empty. */
export const CloseCancelsTheSetup: Story = {
  render: () => wizard(),
  parameters: {
    review: {
      purpose:
        "Confluence setup wizard at the Install Forge app step: the user presses Close before the install, so ctxpipe deletes the empty draft connection.",
    },
    visual: {
      skip: "Behavior test: the story keeps the modal open after Close, a state that the product does not render.",
    },
    msw: { handlers: { page: installHandlers } },
  },
  play: async () => {
    cancelCalls.length = 0
    const body = within(document.body)
    await userEvent.click(await body.findByRole("button", { name: "Close" }))
    await waitFor(() => expect(cancelCalls).toEqual([atlassianConnectionId]))
  },
}

/**
 * "Install" tells the server that the install opened, so a later cancel
 * keeps the draft for the Marketplace install event.
 */
export const InstallMarksTheDraft: Story = {
  render: () => wizard(),
  parameters: {
    visual: {
      skip: "Behavior test: it ends in the same state as WaitForInstall.",
    },
    review: {
      purpose:
        "Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the user clicks Install Forge app on the install step.",
    },
    msw: { handlers: { page: installHandlers } },
  },
  play: async () => {
    intentCalls.length = 0
    const open = window.open
    window.open = () => null
    try {
      const body = within(document.body)
      await userEvent.click(
        await body.findByRole("button", { name: "Install Forge app" }),
      )
      await waitFor(() => expect(intentCalls).toEqual(["true"]))
    } finally {
      window.open = open
    }
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * user adds a space to a Workspace and reaches the merge step.
 */
export const AddToWorkspaces: Story = {
  name: "06 / Add to Workspaces",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status(sInstalled),
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
          workspaceListHandler([docsWorkspace]),
          ...confluenceTreeHandlers,
          connectionUsageHandler([]),
          ...workspaceSourceAddHandlers(addCalls),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    addCalls.length = 0
    const body = within(canvasElement.ownerDocument.body)
    const heading = await body.findByRole("heading", {
      name: "Add Confluence to Workspaces",
    })
    // The modal fades in; wait until the step is visible.
    await waitFor(() => expect(heading).toBeVisible())
    const add = body.getByRole("button", { name: "Add to Workspaces" })
    await expect(add).toBeDisabled()
    await userEvent.click(
      await body.findByRole("checkbox", { name: docsWorkspace.displayName }),
    )
    await userEvent.click(
      await body.findByRole("checkbox", { name: /Engineering/ }),
    )
    await userEvent.click(add)
    // The add opened a pull request: the last step is the merge.
    const merge = await body.findByRole("heading", {
      name: "Merge the pull request",
    })
    await waitFor(() => expect(merge).toBeVisible())
    // The sync starts after the merge, so the last step links the pull request.
    await expect(
      body.getByRole("link", { name: /^acme\/docs#7/ }),
    ).toHaveAttribute("href", "https://github.com/acme/docs/pull/7")
    await expect(addCalls).toEqual([
      {
        method: "POST",
        path: `/${orgSlug}/api/v1/workspaces/${docsWorkspace.slug}/sources`,
        body: {
          source: {
            provider: "confluence",
            connectionId: atlassianConnectionId,
            scope: { spaces: [{ key: "ENG", pages: "all" }] },
          },
        },
      },
    ])
  },
}

/** The Docs Workspace already syncs the ENG space through this connection. */
export const ManageKeepsTheCurrentScope: Story = {
  name: "06b / Manage keeps the current scope",
  render: () => wizard(),
  parameters: {
    review: {
      purpose:
        "Confluence setup wizard opened from Manage on the Confluence card: Add to Workspaces loads the saved scope (Docs syncs the ENG space), so Save changes stays off.",
    },
    msw: {
      handlers: {
        page: [
          status(sInstalled),
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
          workspaceListHandler([docsWorkspace]),
          ...confluenceTreeHandlers,
          connectionUsageHandler([
            connectionUsageItem({
              workspaceSlug: docsWorkspace.slug,
              workspaceName: docsWorkspace.displayName,
              sources: [
                {
                  path: "sources/confluence/confluence.md",
                  provider: "confluence",
                  status: "ok",
                  scopeSummary: "1 Confluence space",
                },
              ],
            }),
          ]),
          workspaceSourcesHandler(
            workspaceSourceList({
              items: [
                workspaceSourceFixture({
                  path: "sources/confluence/confluence.md",
                  provider: "confluence",
                  connectionId: atlassianConnectionId,
                  scope: { spaces: [{ key: "ENG", pages: "all" }] },
                }),
              ],
            }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeChecked(),
    )
    await waitFor(() =>
      expect(body.getByRole("checkbox", { name: /Engineering/ })).toBeChecked(),
    )
    await expect(
      body.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled()
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: a
 * notice says a configuration pull request replaced this setup.
 */
export const ReplacedSetup: Story = {
  name: "07 / Replaced setup with a config pull request",
  render: () => wizard(),
  parameters: {
    msw: {
      handlers: {
        page: [
          status({
            ...sInstalled,
            setupPhase: "awaiting_merge",
            pendingConfigPullUrl: "https://github.com/acme/wiki/pull/12",
          }),
          atlassianOauthHandler({ oauthAppSaved: true }, atlassianConnectionId),
          workspaceListHandler([docsWorkspace]),
          ...confluenceTreeHandlers,
          connectionUsageHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const notice = await body.findByText(/This setup was replaced/)
    // The modal fades in; wait until the notice is visible.
    await waitFor(() => expect(notice).toBeVisible())
    await expect(
      body.getByRole("link", { name: /^configuration pull request/ }),
    ).toHaveAttribute("href", "https://github.com/acme/wiki/pull/12")
    await waitFor(() =>
      expect(
        body.getByRole("checkbox", { name: docsWorkspace.displayName }),
      ).toBeVisible(),
    )
  },
}

/**
 * Confluence setup wizard in a modal, which connects Confluence to ctxpipe: the
 * wizard opened with no connection id.
 */
export const MissingConnectionId: Story = {
  name: "08 / Missing connection id",
  render: () => wizard({ atlassianConnectionId: undefined }),
  parameters: {
    msw: {
      handlers: {
        page: [statusUnscoped(s0)],
      },
    },
  },
}
