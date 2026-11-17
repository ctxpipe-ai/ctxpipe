import type { Meta, StoryObj } from "@storybook/react-vite"

import { PlainMark } from "./PlainMark"

const meta = {
  title: "Components/Connections/Plain/Mark",
  component: PlainMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof PlainMark>

export default meta

type Story = StoryObj<typeof meta>

export const ProductMark: Story = {
  parameters: {
    review: {
      purpose:
        "Plain mark, the logo in the ink color that names Plain on its connector card and setup dialog: the mark alone, enlarged.",
    },
  },
}
