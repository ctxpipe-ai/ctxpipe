import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { pagerdutyServicesHandler } from "@/mocks/pagerduty-handlers"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { PagerdutyScopeEditor } from "./pagerduty"

/** The editor with the scope it reports, as the Choose Workspaces step holds it. */
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
      <output className="mt-4 block text-xs text-muted-foreground">
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
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: [pagerdutyServicesHandler] } },
  },
  args: { initialScope: {} },
} satisfies Meta<typeof EditorWithOutput>

export default meta

type Story = StoryObj<typeof meta>

export const SelectServices: Story = {
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
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: "billing-worker" }),
    )
    // checkout-api is not in the results now, and it stays selected.
    const selected = canvas.getByRole("grid", { name: "Selected" })
    await expect(within(selected).getByText("checkout-api")).toBeVisible()
    await expect(within(selected).getByText("billing-worker")).toBeVisible()
    await expect(
      canvas.getByText(JSON.stringify({ services: ["PSVC001", "PSVC002"] })),
    ).toBeVisible()
  },
}

export const RemoveTheLastService: Story = {
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
