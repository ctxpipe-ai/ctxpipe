import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { EditScopeModal } from "./EditScopeModal"

const orgSlug = "acme"
const atlassianConnectionId = "edit_scope_conn"

const savedConfig = {
  spaces: [
    {
      id: "scope_row_1",
      connectionId: atlassianConnectionId,
      spaceKey: "DOC",
      spaceName: "Documentation",
      selectedPageIds: null as string[] | null,
      lastSyncedPageId: null as string | null,
      lastSyncedAt: null as string | null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ],
  syncTarget: {
    id: "st1",
    orgId: "org_story",
    connectionId: atlassianConnectionId,
    repositoryId: "repo1",
    repositoryName: "acme/ingest",
    branch: "main",
    enabled: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  },
}

const spacesList = {
  items: [{ id: "s1", key: "DOC", name: "Documentation", type: "global" }],
}

function configPredicate(request: Request) {
  const u = new URL(request.url)
  if (!u.pathname.includes("/atlassian/config")) {
    return false
  }
  return u.searchParams.get("connectionId") === atlassianConnectionId
}

const meta = {
  title: "Components/Connections/Atlassian/EditScope",
  component: EditScopeModal,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof EditScopeModal>

export default meta

type Story = StoryObj<typeof meta>

export const ConfigLoading: Story = {
  name: "ConfigLoading",
  render: () => (
    <div className="h-[min(90vh,720px)] w-full max-w-3xl border border-zinc-800">
      <EditScopeModal
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onClose={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => configPredicate(request),
            async () => {
              await delay("infinite")
              return HttpResponse.json(savedConfig)
            },
          ),
        ],
      },
    },
  },
}

export const LoadError: Story = {
  name: "LoadError",
  render: () => (
    <div className="h-[min(90vh,720px)] w-full max-w-3xl border border-zinc-800">
      <EditScopeModal
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onClose={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) => configPredicate(request),
            () => new HttpResponse(null, { status: 500 }),
          ),
        ],
      },
    },
  },
}

const withScopeHandlers = [
  http.get(
    ({ request }) => configPredicate(request),
    () => HttpResponse.json(savedConfig),
  ),
  http.get(
    ({ request }) => {
      const u = new URL(request.url)
      if (!u.pathname.includes("/atlassian/available-spaces")) {
        return false
      }
      if (u.searchParams.get("connectionId") !== atlassianConnectionId) {
        return false
      }
      return u.pathname.endsWith("/available-spaces")
    },
    () => HttpResponse.json(spacesList),
  ),
  http.patch(
    ({ request }) => configPredicate(request),
    () =>
      HttpResponse.json({
        accepted: true,
        savedCount: 1,
        configPrEnqueued: false,
      }),
  ),
]

export const WithScope: Story = {
  name: "WithScope",
  render: () => (
    <div className="h-[min(90vh,720px)] w-full max-w-3xl border border-zinc-800">
      <EditScopeModal
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onClose={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: { page: withScopeHandlers },
    },
  },
}

export const Embedded: Story = {
  name: "Embedded",
  render: () => (
    <div className="h-[min(520px,90vh)] w-full max-w-3xl border border-zinc-800">
      <EditScopeModal
        embedded
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        onClose={() => {}}
      />
    </div>
  ),
  parameters: {
    msw: {
      handlers: { page: withScopeHandlers },
    },
  },
}
