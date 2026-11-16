import type { Meta, StoryObj } from "@storybook/react-vite"
import { PAGERDUTY_SOURCE_MAX_SERVICES } from "backend/domain/workspace-sources/providers/pagerduty"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import { pagerdutyServicesHandler } from "@/mocks/pagerduty-handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PagerdutyScopeEditor } from "./pagerduty"

/** The editor with the scope it reports, as the Add to Workspaces step holds it. */
function EditorWithOutput(props: {
  initialScope: Record<string, unknown>
  label?: string
}) {
  const [scope, setScope] = useState<Record<string, unknown> | null>(null)
  return (
    <>
      <PagerdutyScopeEditor
        orgSlug="acme"
        provider="pagerduty"
        connectionId="con_pagerduty1"
        initialScope={props.initialScope}
        label={props.label}
        onChange={setScope}
      />
      <output className="mt-4 block break-all text-xs text-muted-foreground">
        {scope ? JSON.stringify(scope) : "Not ready"}
      </output>
    </>
  )
}

const meta = {
  title: "Components/WorkspaceSources/PagerdutyScopeEditor",
  component: EditorWithOutput,
  decorators: [
    (Story) => (
      <div className="max-w-lg bg-zinc-950 p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    app: "root",
    queryClient: true,
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
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectServices: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: the user picks two services, one from the second page of the list.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(canvas.getByText("Not ready")).toBeVisible())
    await expect(canvas.getByText("Select at least one service.")).toBeVisible()
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
    await expect(
      canvas.getByText(JSON.stringify({ services: ["PSVC001", "PSVC004"] })),
    ).toBeVisible()
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
  play: async ({ canvasElement }) => {
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
    await expect(
      canvas.getByText(JSON.stringify({ services: ["PSVC001", "PSVC002"] })),
    ).toBeVisible()
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const selected = await canvas.findByRole("grid", { name: "Selected" })
    await waitFor(() =>
      expect(within(selected).getByText("billing-worker")).toBeVisible(),
    )
    await userEvent.click(
      within(selected).getByRole("button", { name: /Remove/ }),
    )
    await expect(canvas.getByText("Not ready")).toBeVisible()
    await expect(canvas.getByText("Select at least one service.")).toBeVisible()
  },
}

export const ServiceListFails: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: the service list did not load, so an error shows.",
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
  },
}

export const OverTheServiceLimit: Story = {
  parameters: {
    review: {
      purpose:
        "PagerDuty scope editor, where the user picks the services of a Workspace source: the selection goes above the service limit, so an error shows and the scope is not ready.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
  },
  args: {
    // A full selection: one more service goes above the cap.
    initialScope: {
      services: Array.from(
        { length: PAGERDUTY_SOURCE_MAX_SERVICES },
        (_, i) => `PX${String(i).padStart(3, "0")}`,
      ),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body)
    const limit = `Select at most ${PAGERDUTY_SOURCE_MAX_SERVICES} PagerDuty services.`
    const checkout = await canvas.findByRole("checkbox", {
      name: "checkout-api",
    })
    await expect(canvas.queryByText(limit)).not.toBeInTheDocument()
    await userEvent.click(checkout)
    await waitFor(() => expect(canvas.getByText(limit)).toBeVisible())
    await expect(canvas.getByText("Not ready")).toBeVisible()
    // One service less is in the cap again, and the scope is ready.
    await userEvent.click(
      canvas.getByRole("checkbox", { name: "checkout-api" }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/^\{"services":\["PX000",/)).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.queryByText(limit)).not.toBeInTheDocument(),
    )
  },
}
