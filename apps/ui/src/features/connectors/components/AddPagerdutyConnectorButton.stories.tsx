import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { AddPagerdutyConnectorButton } from "./AddPagerdutyConnectorButton"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/PagerDuty/AddConnectorButton",
  component: AddPagerdutyConnectorButton,
  parameters: {
    layout: "centered",
    msw: {
      handlers: {
        page: [
          http.post(`/${orgSlug}/api/v1/connectors/pagerduty/setup`, () =>
            HttpResponse.json({ connectionId: "con_pd_draft" }),
          ),
        ],
      },
    },
  },
  args: { orgSlug, onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddPagerdutyConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

export const SelfHosted: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /PagerDuty/ }),
    )
    await waitFor(() =>
      expect(args.onStart).toHaveBeenCalledWith({
        connectionId: "con_pd_draft",
      }),
    )
  },
}

export const Hosted: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(`/${orgSlug}/api/v1/connectors/pagerduty/setup`, () =>
            HttpResponse.json({ connectionId: null }),
          ),
        ],
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /PagerDuty/ }),
    )
    await waitFor(() =>
      expect(args.onStart).toHaveBeenCalledWith({
        connectionId: undefined,
      }),
    )
  },
}
