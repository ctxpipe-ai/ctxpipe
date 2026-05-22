import type { Meta, StoryObj } from "@storybook/react-vite"
import { ConfluenceMark } from "./ConfluenceMark"

const meta = {
  title: "Components/Connections/Atlassian/Mark",
  component: ConfluenceMark,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof ConfluenceMark>

export default meta

type Story = StoryObj<typeof meta>

export const Mark: Story = {
  render: () => <ConfluenceMark className="size-16" />,
}
