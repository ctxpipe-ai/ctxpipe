import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { useState } from "react"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { SpacePageTree } from "./SpacePageTree"
import type { SpaceScopeItem } from "./types"

const orgSlug = "acme"
const atlassianConnectionId = "tree_conn"

const meta = {
  title: "Components/Connections/Atlassian/SpacePageTree",
  component: SpacePageTree,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof SpacePageTree>

export default meta

type Story = StoryObj<typeof meta>

function TreeHarness() {
  const [value, setValue] = useState<SpaceScopeItem[]>([])
  return (
    <div className="h-96 w-full max-w-md overflow-y-auto border border-zinc-800 p-2">
      <SpacePageTree
        orgSlug={orgSlug}
        atlassianConnectionId={atlassianConnectionId}
        value={value}
        onChange={setValue}
      />
    </div>
  )
}

export const Loading: Story = {
  render: () => <TreeHarness />,
  parameters: {
    msw: {
      handlers: [
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
      ],
    },
  },
}

export const List: Story = {
  name: "List",
  render: () => <TreeHarness />,
  parameters: {
    msw: {
      handlers: [
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
      ],
    },
  },
}

export const ErrorState: Story = {
  name: "Error",
  render: () => <TreeHarness />,
  parameters: {
    msw: {
      handlers: [
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
      ],
    },
  },
}
