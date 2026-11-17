import type { Meta, StoryObj } from "@storybook/react-vite"

import { ZendeskMark } from "./ZendeskMark"

const meta = {
  title: "Components/Connections/Zendesk/Mark",
  component: ZendeskMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof ZendeskMark>

export default meta

type Story = StoryObj<typeof meta>

/**
 * Zendesk product mark, the logo that names the provider on connector cards and
 * dialogs: the mark alone at a large size.
 */
export const ProductMark: Story = {}
