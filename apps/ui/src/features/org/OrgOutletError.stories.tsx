import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { OrgGateError } from "./OrgGateError"
import { OrgOutletError } from "./OrgOutletError"

const meta = {
  title: "Components/Org/OutletError",
  component: OrgOutletError,
} satisfies Meta<typeof OrgOutletError>

export default meta

type Story = StoryObj<typeof meta>

export const ConnectorsFailed: Story = {
  args: {
    title: "Could not load connectors",
    error: new Error("Failed to load connections"),
    reset: () => undefined,
  },
}

/** The org gate timed out during the server render. */
export const OrgGateFailed: Story = {
  args: {
    title: "Something went wrong",
    error: new Error("The operation timed out."),
    reset: () => undefined,
  },
}

/** The first org gate load fails. Try again runs the loader again, and the page loads. */
export const OrgGateTryAgainLoads: Story = {
  parameters: {
    intent:
      "Catches an organization error screen whose Try again button does not load the page again. After a failed session check, a retry must show the organization page. Not for error text.",
  },
  tags: ["workspace-golden"],
  args: OrgGateFailed.args,
  render: () => <OrgGateRetryRouter />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Session check failed (504)")).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(canvas.getByText("Org page")).toBeVisible())
  },
}

function OrgGateRetryRouter() {
  const [router] = useState(() => {
    let loads = 0
    const rootRoute = createRootRoute()
    const orgRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$orgSlug",
      loader: () => {
        loads += 1
        if (loads === 1) throw new Error("Session check failed (504)")
      },
      errorComponent: OrgGateError,
      component: () => <p>Org page</p>,
    })
    return createRouter({
      routeTree: rootRoute.addChildren([orgRoute]),
      history: createMemoryHistory({ initialEntries: ["/acme"] }),
    })
  })
  return <RouterProvider router={router} />
}
