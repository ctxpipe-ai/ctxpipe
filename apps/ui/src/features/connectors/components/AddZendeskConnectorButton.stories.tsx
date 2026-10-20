import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { AddZendeskConnectorButton } from "./AddZendeskConnectorButton"

const meta = {
  title: "Components/Connections/Zendesk/AddConnectorButton",
  component: AddZendeskConnectorButton,
  parameters: { layout: "centered" },
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddZendeskConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

/** The setup starts at the account step; the subdomain creates the row. */
export const OpensSetup: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /Zendesk/ }),
    )
    await expect(args.onStart).toHaveBeenCalledTimes(1)
  },
}
