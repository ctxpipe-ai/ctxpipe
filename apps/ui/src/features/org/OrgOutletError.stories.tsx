import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { ApiError } from "@/lib/api-result"

import preview from "../../../.storybook/preview"
import { OrgGateError } from "./OrgGateError"
import { OrgOutletError } from "./OrgOutletError"

const meta = preview.meta({
  title: "Components/Org/OutletError",
  component: OrgOutletError,
})

/**
 * Error alert in the body of an org page: the connections read failed with a
 * server error 503, a request id and no reason in the body. The alert says
 * where it failed and the next step, and it does not repeat the title with the
 * fallback message of the query.
 */
export const ConnectorsFailed = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
  args: {
    title: "Could not load connectors",
    error: new ApiError("Failed to load connections", 503, {
      requestId: "req_01hx7f3a9c",
    }),
    reset: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("The server had an error (status 503)."),
    ).toBeVisible()
    await expect(canvas.getByText("req_01hx7f3a9c")).toBeVisible()
    await expect(
      canvas.queryByText("Failed to load connections"),
    ).not.toBeInTheDocument()
  },
})

/**
 * Error alert in the body of an org page: the product fetch hit its own timeout
 * (ApiError status 0). The alert does not blame the network connection, and the
 * fetch error shows.
 */
export const RequestTimedOut = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
  args: {
    title: "Could not load connectors",
    error: new ApiError("signal timed out", 0, {
      cause: new DOMException("signal timed out", "TimeoutError"),
    }),
    reset: () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("The server did not answer in time."),
    ).toBeVisible()
    await expect(canvas.getByText("signal timed out")).toBeVisible()
    await expect(
      canvas.queryByText(/could not reach the server/),
    ).not.toBeInTheDocument()
  },
})

/**
 * Error alert in the body of an org page, where the user can try the load
 * again: the org check timed out during the server render.
 */
export const OrgGateFailed = meta.story({
  parameters: {
    review: {
      kind: "component",
    },
  },
  args: {
    title: "Something went wrong",
    error: new Error("The operation timed out."),
    reset: () => undefined,
  },
})

/**
 * Error screen of the org check in a test router: the first load failed, and
 * the user pressed Try again. The loader ran again, and the org page text
 * shows.
 */
export const OrgGateTryAgainLoads = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a story route marker, which the product does not render.",
    },
    intent:
      "Catches an organization error screen whose Try again button does not load the page again. After a failed session check, a retry must show the organization page. Not for error text.",
    review: {
      kind: "component",
    },
  },
  tags: ["required"],
  args: OrgGateFailed.input.args,
  render: () => <OrgGateRetryRouter />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Session check failed (504)")).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(canvas.getByText("Org page")).toBeVisible())
  },
})

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
