import type { Meta, StoryObj } from "@storybook/react-vite"
import { LinkAtlassianStep } from "./LinkAtlassianStep"

const meta = {
  title: "Components/Connections/Atlassian/Steps/LinkAtlassian",
  component: LinkAtlassianStep,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof LinkAtlassianStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <LinkAtlassianStep />,
}
