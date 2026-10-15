import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import { responseGate } from "@/components/ui/skeletonMatchStory"
import { ConnectedAppsCard } from "./ConnectedAppsCard"

const meta = {
  title: "Components/Auth/Connected Apps Card",
  component: ConnectedAppsCard,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ConnectedAppsCard>

export default meta

type Story = StoryObj<typeof meta>

const gate = responseGate()

/**
 * While the apps load, each skeleton row has the box of a loaded row: the same
 * height, and the same position and size for the two action buttons.
 */
export const SkeletonRowMatchesLoadedRow: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/me/connected-apps",
              ),
            async () => {
              await gate.wait()
              return HttpResponse.json({
                apps: [
                  {
                    id: "consent_1",
                    legacy: false,
                    clientId: "client_1",
                    clientName: "Example MCP client",
                    scopes: ["ctxpipe:read"],
                    organizations: [
                      { id: "org_a", slug: "acme", name: "Acme" },
                    ],
                    connectedAt: null,
                  },
                ],
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect()
      return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
      }
    }
    const skeletonRow = canvasElement.querySelector("div[aria-hidden] > div")
    if (!skeletonRow) throw new Error("No skeleton row")
    const skeletonActions = skeletonRow.lastElementChild
    if (!skeletonActions) throw new Error("The skeleton row has no actions")
    const skeleton = {
      row: rect(skeletonRow),
      actions: [...skeletonActions.children].map(rect),
    }
    expect(skeleton.actions).toHaveLength(2)

    await gate.release()
    const loadedRow = (await within(canvasElement).findAllByRole("listitem"))[0]
    const loaded = {
      row: rect(loadedRow),
      actions: within(loadedRow).getAllByRole("button").map(rect),
    }
    expect(loaded.actions).toHaveLength(2)
    expect(skeleton).toEqual(loaded)
  },
}
