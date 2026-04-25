import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { ConfluenceSetupWizard } from "./confluence-setup/ConfluenceSetupWizard"

const orgSlug = "acme"
const atlassianConnectionId = "wizard_conn_1"

const statusBase = {
  isLinked: false,
  isInstalled: false,
  installationStatus: null as string | null,
  isGithubLinked: false,
  selectedSpaceCount: 0,
  syncTargetConfigured: false,
  syncTarget: null as {
    repositoryId: string
    repositoryName: string
    branch: string
  } | null,
  selectedSpaces: [] as { spaceKey: string; spaceName: string | null }[],
}

function statusHandler(
  body: Record<string, unknown> | (() => Promise<Response>),
) {
  return http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/api/v1/connectors/atlassian/status"))
        return false
      return u.searchParams.get("connectionId") === atlassianConnectionId
    },
    typeof body === "function" ? body : () => HttpResponse.json(body),
  )
}

const meta = {
  title: "Components/Connections/ConfluenceSetupWizard",
  component: ConfluenceSetupWizard,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof ConfluenceSetupWizard>

export default meta

type Story = StoryObj<typeof meta>

const wrap = (story: React.ReactNode) => (
  <div className="min-h-40 p-4">{story}</div>
)

export const Loading: Story = {
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
        statusHandler(async () => {
          await delay("infinite")
          return HttpResponse.json(statusBase)
        }),
      ],
      },
    },
  },
}

export const ErrorState: Story = {
  name: "Error",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
          statusHandler(
            async () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

export const Link: Story = {
  name: "Body/Link",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [statusHandler({ ...statusBase, isLinked: false })],
      },
    },
  },
}

export const Install: Story = {
  name: "Body/Install",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
        statusHandler({
          ...statusBase,
          isLinked: true,
          isInstalled: false,
        }),
      ],
      },
    },
  },
}

export const GitHub: Story = {
  name: "Body/GitHub",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
        statusHandler({
          ...statusBase,
          isLinked: true,
          isInstalled: true,
          installationStatus: "installed",
          isGithubLinked: false,
        }),
      ],
      },
    },
  },
}

export const Target: Story = {
  name: "Body/Target",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
        statusHandler({
          ...statusBase,
          isLinked: true,
          isInstalled: true,
          installationStatus: "installed",
          isGithubLinked: true,
          syncTargetConfigured: false,
        }),
        http.get(
          ({ request }) =>
            new URL(request.url).pathname === `/${orgSlug}/api/v1/repositories`,
          () =>
            HttpResponse.json({
              items: [
                {
                  id: "repo_1",
                  name: "ingest",
                  gitUrl: "https://github.com/acme/ingest.git",
                },
              ],
            }),
        ),
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/github/installation/repositories"))
              return false
            return u.searchParams.get("q") !== null
          },
          () =>
            HttpResponse.json({
              repositories: [
                {
                  id: 1,
                  full_name: "acme/ingest",
                  html_url: "https://github.com/acme/ingest",
                  clone_url: "https://github.com/acme/ingest.git",
                  name: "ingest",
                  default_branch: "main",
                },
              ],
              repositorySelection: "selected",
              hasMore: false,
            }),
        ),
        http.get(
          ({ request }) => {
            const u = new URL(request.url)
            if (!u.pathname.includes("/atlassian/config")) return false
            if (u.searchParams.get("connectionId") !== atlassianConnectionId)
              return false
            return true
          },
          () => new HttpResponse(null, { status: 409 }),
        ),
      ],
      },
    },
  },
}

export const Complete: Story = {
  name: "Body/Complete",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        isOpen
        onOpenChange={() => {}}
      />,
    ),
  parameters: {
    msw: {
      handlers: {
        page: [
        statusHandler({
          isLinked: true,
          isInstalled: true,
          installationStatus: "installed",
          isGithubLinked: true,
          selectedSpaceCount: 1,
          syncTargetConfigured: true,
          syncTarget: {
            repositoryId: "r1",
            repositoryName: "acme/ingest",
            branch: "main",
          },
          selectedSpaces: [{ spaceKey: "S1", spaceName: "Space" }],
        }),
      ],
      },
    },
  },
}

export const MissingConnection: Story = {
  name: "Body/Scope/MissingConnection",
  render: () =>
    wrap(
      <ConfluenceSetupWizard
        orgSlug={orgSlug}
        atlassianConnectionId={undefined}
        isOpen
        onOpenChange={() => {}}
      />,
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
            if (u.searchParams.has("connectionId")) {
              return false
            }
            return true
          },
          () =>
            HttpResponse.json({
              isLinked: true,
              isInstalled: true,
              installationStatus: "installed",
              isGithubLinked: true,
              selectedSpaceCount: 0,
              syncTargetConfigured: true,
              syncTarget: {
                repositoryId: "r1",
                repositoryName: "acme/ingest",
                branch: "main",
              },
              selectedSpaces: [],
            }),
        ),
      ],
      },
    },
  },
}
