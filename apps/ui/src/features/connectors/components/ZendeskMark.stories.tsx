import type { Meta, StoryObj } from "@storybook/react-vite"

import { ZendeskMark } from "./ZendeskMark"

const meta = {
  title: "Components/Connections/Zendesk/Mark",
  component: ZendeskMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof ZendeskMark>

export default meta

type Story = StoryObj<typeof meta>

export const ProductMark: Story = {}
