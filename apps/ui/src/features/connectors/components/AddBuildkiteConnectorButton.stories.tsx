import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"
import { AddBuildkiteConnectorButton } from "./AddBuildkiteConnectorButton"

const meta = {
  title: "Components/Connections/Buildkite/AddConnectorButton",
  component: AddBuildkiteConnectorButton,
  parameters: { layout: "centered" },
  args: { onStart: fn() },
  decorators: [
    (Story) => (
      <div className="w-[min(32rem,90vw)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AddBuildkiteConnectorButton>

export default meta

type Story = StoryObj<typeof meta>

/** The token step needs no draft row, so the click only opens setup. */
export const OpensSetup: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: /Buildkite/ }),
    )
    await expect(args.onStart).toHaveBeenCalledTimes(1)
  },
}
