import type { Meta, StoryObj } from "@storybook/react-vite"
import { PAGERDUTY_SOURCE_MAX_SERVICES } from "backend/domain/workspace-sources/providers/pagerduty"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { pagerdutyServicesHandler } from "@/mocks/pagerduty-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { sourceDialogStoryFrame } from "../source-dialog-story-frame"
import { PagerdutyScopeEditor } from "./pagerduty"

const meta = {
  title: "Components/WorkspaceSources/PagerdutyScopeEditor",
  component: PagerdutyScopeEditor,
  decorators: [sourceDialogStoryFrame],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: { session: signedInHandlers, page: [pagerdutyServicesHandler] },
    },
  },
  args: {
    orgSlug: "acme",
    provider: "pagerduty",
    connectionId: "con_pagerduty1",
    initialScope: {},
    onChange: fn(),
  },
} satisfies Meta<typeof PagerdutyScopeEditor>

export default meta

type Story = StoryObj<typeof meta>

export const SelectServices: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: the user picks two services, one from the second page of the list.",
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(canvas.getByText("Select at least one service.")).toBeVisible(),
    )
    await expect(args.onChange).not.toHaveBeenCalled()
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "checkout-api" }),
    )
    // The second page of services comes on request.
    await userEvent.click(
      canvas.getByRole("button", { name: "Show more services" }),
    )
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "status-page" }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith({
      services: ["PSVC001", "PSVC004"],
    })
    const selected = canvas.getByRole("grid", { name: "Selected" })
    await expect(within(selected).getByText("checkout-api")).toBeVisible()
    await expect(within(selected).getByText("status-page")).toBeVisible()
  },
}

export const SearchKeepsTheSelection: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: a search hides a selected service, but it stays in the selected list with its name.",
    },
  },
  args: { label: "On-call", initialScope: { services: ["PSVC001"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByRole("checkbox", { name: "checkout-api" }),
      ).toBeChecked(),
    )
    await userEvent.type(
      canvas.getByRole("searchbox", {
        name: "Search PagerDuty services for On-call",
      }),
      "billing",
    )
    // The search starts after a pause in the typing. Wait for its result,
    // which does not hold checkout-api.
    await waitFor(() =>
      expect(
        canvas.queryByRole("checkbox", { name: "checkout-api" }),
      ).not.toBeInTheDocument(),
    )
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "billing-worker" }),
    )
    // checkout-api is not in the results now. It stays selected, with its
    // name: the initial scope gave only its id.
    const selected = canvas.getByRole("grid", { name: "Selected" })
    await expect(within(selected).getByText("checkout-api")).toBeVisible()
    await expect(within(selected).getByText("billing-worker")).toBeVisible()
    expect(within(selected).queryByText("PSVC001")).not.toBeInTheDocument()
    await expect(args.onChange).toHaveBeenLastCalledWith({
      services: ["PSVC001", "PSVC002"],
    })
  },
}

export const RemoveTheLastService: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: the user removes the last selected service, so the scope is not ready.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
  },
  args: { initialScope: { services: ["PSVC002"] } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const selected = await canvas.findByRole("grid", { name: "Selected" })
    await waitFor(() =>
      expect(within(selected).getByText("billing-worker")).toBeVisible(),
    )
    await userEvent.click(
      within(selected).getByRole("button", { name: /Remove/ }),
    )
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
    await expect(canvas.getByText("Select at least one service.")).toBeVisible()
  },
}

export const ServiceListFails: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor in the Add source dialog: the request for the PagerDuty services failed, so an error alert stands in place of the service list.",
    },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/available-services",
              ),
            () => HttpResponse.json({ error: "Server error" }, { status: 500 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(
        canvas.getByText("Could not load PagerDuty services. Try again."),
      ).toBeVisible(),
    )
    // The error is the one message: no hint asks for a selection.
    await expect(canvas.queryByText("Select at least one service.")).toBeNull()
  },
}

// One more service than a source can hold. Each product area has an API, a
// worker, a database, a queue and a cron job, as in a real PagerDuty account.
const manyServices = [
  "accounts",
  "analytics",
  "auth",
  "billing",
  "catalog",
  "checkout",
  "exports",
  "gateway",
  "imports",
  "inventory",
  "ledger",
  "notifications",
  "orders",
  "payments",
  "pricing",
  "recommendations",
  "reviews",
  "scheduler",
  "search",
  "shipping",
  "webhooks",
]
  .flatMap((area) =>
    ["api", "worker", "db", "queue", "cron"].map((part) => `${area}-${part}`),
  )
  .slice(0, PAGERDUTY_SOURCE_MAX_SERVICES + 1)
  .map((name, index) => ({
    id: `PSV${String(index + 1).padStart(4, "0")}`,
    name,
  }))

export const OverTheServiceLimit: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor in the Add source dialog: 100 services are selected, the user ticks one more, so an error states the 100-service limit and the dialog cannot save.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/connectors/pagerduty/available-services",
              ),
            () => HttpResponse.json({ items: manyServices, more: false }),
          ),
        ],
      },
    },
  },
  args: {
    // A full selection: all services but the first.
    initialScope: {
      services: manyServices.slice(1).map((service) => service.id),
    },
  },
  play: async ({ args, canvasElement }) => {
    await expect(manyServices).toHaveLength(PAGERDUTY_SOURCE_MAX_SERVICES + 1)
    const canvas = within(canvasElement.ownerDocument.body)
    const limit = `Select at most ${PAGERDUTY_SOURCE_MAX_SERVICES} PagerDuty services.`
    const first = await canvas.findByRole("checkbox", {
      name: manyServices[0]?.name,
    })
    await expect(canvas.queryByText(limit)).not.toBeInTheDocument()
    await userEvent.click(first)
    await waitFor(() => expect(canvas.getByText(limit)).toBeVisible())
    // Above the cap, the scope is not ready, so the dialog cannot save.
    await expect(args.onChange).toHaveBeenLastCalledWith(null)
  },
}
