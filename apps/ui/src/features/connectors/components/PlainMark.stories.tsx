import type { Meta, StoryObj } from "@storybook/react-vite"

import { PlainMark } from "./PlainMark"

const meta = {
  title: "Components/Connections/Plain/Mark",
  component: PlainMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof PlainMark>

export default meta

type Story = StoryObj<typeof meta>

export const ProductMark: Story = {}
