import type { Meta, StoryObj } from "@storybook/react-vite"

import { BuildkiteMark } from "./BuildkiteMark"

const meta = {
  title: "Components/Connections/Buildkite/Mark",
  component: BuildkiteMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof BuildkiteMark>

export default meta

type Story = StoryObj<typeof meta>

export const ProductMark: Story = {}
