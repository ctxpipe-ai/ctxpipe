import type { Meta, StoryObj } from "@storybook/react-vite"

import { PagerdutyMark } from "./PagerdutyMark"

const meta = {
  title: "Components/Connections/PagerDuty/Mark",
  component: PagerdutyMark,
  parameters: { layout: "centered", review: { kind: "component" } },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof PagerdutyMark>

export default meta

type Story = StoryObj<typeof meta>

/**
 * PagerDuty product mark, the logo that names the provider on connector cards
 * and dialogs: the mark alone at a large size.
 */
export const ProductMark: Story = {}
