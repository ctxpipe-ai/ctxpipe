import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { Switch } from "./Switch"

const meta = {
  title: "Components/Switch",
  component: Switch,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Switch>

export default meta

type Story = StoryObj<typeof meta>

function Controlled(props: {
  isDisabled?: boolean
  defaultSelected?: boolean
}) {
  const [on, setOn] = useState(props.defaultSelected ?? false)
  return (
    <Switch
      isSelected={on}
      onChange={setOn}
      {...(props.isDisabled ? { isDisabled: true } : {})}
    >
      Automatic upgrades
    </Switch>
  )
}

/** A press and the Space key change the setting. */
export const Toggles: Story = {
  render: () => <Controlled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("switch", { name: "Automatic upgrades" })
    await expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    await userEvent.keyboard(" ")
    await waitFor(() => expect(toggle).not.toBeChecked())
  },
}

/** A disabled switch shows its setting and does not change. */
export const Disabled: Story = {
  render: () => <Controlled defaultSelected isDisabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("switch", { name: "Automatic upgrades" })
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeDisabled()
    await userEvent.click(toggle, { pointerEventsCheck: 0 })
    await waitFor(() => expect(toggle).toBeChecked())
  },
}
