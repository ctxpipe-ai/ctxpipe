import type { Meta, StoryObj } from "@storybook/react-vite"
import { InlineLoader, ProgressLoader } from "./InlineLoader"

const meta = {
  title: "Components/InlineLoader",
  component: InlineLoader,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof InlineLoader>

export default meta

type Story = StoryObj<typeof meta>

export const Indeterminate: Story = {
  args: {
    label: "Loading repositories",
  },
}

export const Determinate: Story = {
  render: () => (
    <ProgressLoader label="Indexing" sublabel="7 / 22" progress={32} />
  ),
}
