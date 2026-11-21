import { delay, HttpResponse, http } from "msw"
import { useState } from "react"

import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { SpacePageTree } from "./SpacePageTree"
import type { SpaceScopeItem } from "./types"

const orgSlug = "acme"
const atlassianConnectionId = "tree_conn"

const meta = preview.meta({
  title: "Components/Connections/Atlassian/SpacePageTree",
  component: SpacePageTree,
  decorators: [
    (Story) => (
      <div className="h-96 w-full max-w-md overflow-y-auto border border-zinc-800 p-2">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
})

function SpacePageTreeHarness() {
  const [value, setValue] = useState<SpaceScopeItem[]>([])
  return (
    <SpacePageTree
      orgSlug={orgSlug}
      atlassianConnectionId={atlassianConnectionId}
      value={value}
      onChange={setValue}
    />
  )
}

/**
 * Tree where the user picks the Confluence spaces and pages to import: two
 * spaces loaded, none selected yet.
 */
export const List = meta.story({
  render: () => <SpacePageTreeHarness />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/atlassian/available-spaces")) {
            return false
          }
          if (!u.pathname.endsWith("/available-spaces")) {
            return false
          }
          return u.searchParams.get("connectionId") === atlassianConnectionId
        },
        () =>
          HttpResponse.json({
            items: [
              { id: "s1", key: "DEMO", name: "Demo space", type: "global" },
              { id: "s2", key: "TEAM", name: "Team", type: "global" },
            ],
          }),
      ),
    )
  },
})

/**
 * Tree where the user picks the Confluence spaces and pages to import: the
 * space list is still loading.
 */
export const Loading = meta.story({
  render: () => <SpacePageTreeHarness />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/atlassian/available-spaces")) {
            return false
          }
          if (!u.pathname.endsWith("/available-spaces")) {
            return false
          }
          return u.searchParams.get("connectionId") === atlassianConnectionId
        },
        async () => {
          await delay("infinite")
          return HttpResponse.json({ items: [] })
        },
      ),
    )
  },
})

/**
 * Tree where the user picks the Confluence spaces and pages to import: the
 * space list request failed.
 */
export const ErrorState = meta.story({
  name: "Error",
  render: () => <SpacePageTreeHarness />,
  beforeEach: ({ msw }) => {
    msw.use(
      http.get(
        ({ request }) => {
          const u = new URL(request.url)
          if (!u.pathname.includes("/atlassian/available-spaces")) {
            return false
          }
          if (!u.pathname.endsWith("/available-spaces")) {
            return false
          }
          return u.searchParams.get("connectionId") === atlassianConnectionId
        },
        () => new HttpResponse(null, { status: 500 }),
      ),
    )
  },
})
