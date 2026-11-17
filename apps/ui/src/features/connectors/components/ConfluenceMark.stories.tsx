import type { Meta, StoryObj } from "@storybook/react-vite"

import { ConfluenceMark } from "./ConfluenceMark"

const meta = {
  title: "Components/Connections/Atlassian/Mark",
  component: ConfluenceMark,
  parameters: { layout: "centered" },
  args: { className: "size-10 text-foreground" },
} satisfies Meta<typeof ConfluenceMark>

export default meta

type Story = StoryObj<typeof meta>

export const Mark: Story = {
  parameters: {
    review: {
      kind: "component",
      purpose:
        "Confluence mark, the outline logo in the ink color that names Confluence on its connector card, setup dialog and Workspace sources: the mark alone, enlarged.",
    },
  },
}
