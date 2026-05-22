import type { Decorator, Meta, StoryObj } from "@storybook/react-vite"
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

function modalChrome(heightClass: string): Decorator {
  return (Story) => (
    <div className={`${heightClass} w-full max-w-3xl border border-zinc-800`}>
      <Story />
    </div>
  )
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

function modalContent(embedded?: boolean) {
  return (
    <EditScopeModal
      embedded={embedded}
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      onClose={() => {}}
    />
  )
}

export const EditScope: Story = {
  decorators: [modalChrome("h-[min(90vh,720px)]")],
  render: () => modalContent(),
  parameters: {
    msw: {
      handlers: { page: withScopeHandlers },
    },
  },
}

export const ConfigLoading: Story = {
  decorators: [modalChrome("h-[min(90vh,720px)]")],
  render: () => modalContent(),
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
  decorators: [modalChrome("h-[min(90vh,720px)]")],
  render: () => modalContent(),
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

export const Embedded: Story = {
  decorators: [modalChrome("h-[min(520px,90vh)]")],
  render: () => modalContent(true),
  parameters: {
    msw: {
      handlers: { page: withScopeHandlers },
    },
  },
}
