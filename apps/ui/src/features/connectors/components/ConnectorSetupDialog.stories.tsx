import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConnectorSetupDialog } from "./ConnectorSetupDialog"

const orgSlug = "acme"
const atlassianConnectionId = "conn_alias"

/**
 * `ConnectorSetupDialog` is a barrel alias for `ConfluenceSetupWizard`.
 * Use **Components → Connections → Atlassian → ConfluenceSetupWizard** for the
 * numbered end-to-end flow (loading, each step, complete, error).
 */
const meta = {
  title: "Components/Connections/ConnectorSetupDialog",
  component: ConnectorSetupDialog,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof ConnectorSetupDialog>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  name: "Preview (use ConfluenceSetupWizard for full flow)",
  render: () => (
    <div className="w-full min-w-[min(100vw,42rem)] p-2">
      <ConnectorSetupDialog
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status")) {
                return false
              }
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () =>
              HttpResponse.json({
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
                  repositoryName: "acme/ingest",
                  branch: "main",
                },
                selectedSpaces: [{ spaceKey: "DOC", spaceName: "Docs" }],
              }),
          ),
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              return (
                u.pathname === `/${orgSlug}/api/v1/org/atlassian-oauth` &&
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            ({ request }) =>
              HttpResponse.json({
                oauthAppSaved: true,
                atlassianOAuthClientId: "client-preview",
                globalAtlassianOAuthConfigured: false,
                oauthCallbackUrl: `${new URL(request.url).origin}/api/v1/integrations/atlassian/callback`,
                atlassianCreateUrl:
                  "https://developer.atlassian.com/cloud/oauth-2-3lo-apps",
              }),
          ),
        ],
      },
    },
  },
}
