import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { fn } from "storybook/test"
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
          http.post(`/${orgSlug}/api/v1/connectors/pagerduty/draft`, () =>
            HttpResponse.json({ connectionId: "con_pd_draft" }),
          ),
        ],
      },
    },
  },
  args: { orgSlug, onDraftCreated: fn() },
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

export const Available: Story = {}
