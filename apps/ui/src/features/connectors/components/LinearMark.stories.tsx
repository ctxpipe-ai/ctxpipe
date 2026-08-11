import type { Meta, StoryObj } from "@storybook/react-vite"
import { LinearMark } from "./LinearMark"

const meta = {
  title: "Components/Connections/Linear/Mark",
  component: LinearMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof LinearMark>

export default meta

type Story = StoryObj<typeof meta>

export const ProductMark: Story = {}
