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
        "Plain product mark, the logo that names the provider on connector cards and dialogs: the mark alone at a large size.",
    },
  },
}
