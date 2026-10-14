import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { AddPlainConnectorButton } from "./AddPlainConnectorButton"

const meta = {
  title: "Components/Connections/Plain/AddConnectorButton",
  component: AddPlainConnectorButton,
  parameters: { layout: "centered" },
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddPlainConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

/** The key step needs no draft row, so the click only opens setup. */
export const OpensSetup: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /Plain/ }),
    )
    await expect(args.onStart).toHaveBeenCalledTimes(1)
  },
}
