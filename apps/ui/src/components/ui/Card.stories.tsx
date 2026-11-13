import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./Card"

const meta = {
  title: "Components/Card",
  component: Card,
  decorators: [
    (Story) => (
      <div className="w-96 p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>

/** A normal card has no corner crosses. */
export const Default: Story = {
  render: (args) => (
    <Card {...args}>
      <CardHeader>
        <CardTitle>API keys</CardTitle>
        <CardDescription>Keys let a script call ctxpipe.</CardDescription>
      </CardHeader>
      <CardContent>No keys yet.</CardContent>
    </Card>
  ),
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("[data-slot=card]")
    await expect(card?.querySelectorAll("svg")).toHaveLength(0)
  },
}

/** A hero or summary card opts in to the corner crosses. */
export const WithCorners: Story = {
  args: { corners: true },
  render: (args) => (
    <Card {...args}>
      <CardHeader>
        <CardTitle>This week</CardTitle>
        <CardDescription>12 commits in 3 workspaces.</CardDescription>
      </CardHeader>
    </Card>
  ),
  play: async ({ canvasElement }) => {
    const card = canvasElement.querySelector("[data-slot=card]")
    await expect(card?.querySelectorAll("svg")).toHaveLength(4)
  },
}
