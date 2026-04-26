import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { InstallForgeStep } from "./InstallForgeStep"

const orgSlug = "acme"
const atlassianConnectionId = "install_step_conn"

const capabilitiesHandler = http.get(
  ({ request }) => {
    const u = new URL(request.url)
    return (
      u.pathname.endsWith("/api/v1/capabilities") &&
      u.searchParams.get("connectionId") === atlassianConnectionId
    )
  },
  () =>
    HttpResponse.json({
      confluenceForgeInstallUrl: "https://example.com/marketplace/forge",
    }),
)

const meta = {
  title: "Components/Connections/Atlassian/Steps/InstallForge",
  component: InstallForgeStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof InstallForgeStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          capabilitiesHandler,
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () => HttpResponse.json({ id: "post_forge" }),
          ),
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
                return false
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () =>
              HttpResponse.json({
                isLinked: true,
                isInstalled: false,
                installationStatus: null,
                isGithubLinked: false,
                selectedSpaceCount: 0,
                syncTargetConfigured: false,
                syncTarget: null,
                selectedSpaces: [],
              }),
          ),
        ],
      },
    },
  },
}

export const Pending: Story = {
  name: "Pending",
  render: () => (
    <div className="w-full max-w-md p-2">
      <InstallForgeStep
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onOpenedInstall={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          capabilitiesHandler,
          http.post(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/atlassian/installation",
              ),
            () => new Promise(() => {}),
          ),
          http.get(
            ({ request }) => {
              const u = new URL(request.url)
              if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
                return false
              return (
                u.searchParams.get("connectionId") === atlassianConnectionId
              )
            },
            () =>
              HttpResponse.json({
                isLinked: true,
                isInstalled: false,
                installationStatus: null,
                isGithubLinked: false,
                selectedSpaceCount: 0,
                syncTargetConfigured: false,
                syncTarget: null,
                selectedSpaces: [],
              }),
          ),
        ],
      },
    },
  },
}
