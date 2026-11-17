import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import preview from "../../../.storybook/preview"
import { Switch } from "./Switch"

const meta = preview.meta({
  title: "Components/Switch",
  component: Switch,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
})

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

/**
 * Switch that turns a setting on or off: the user turned it on and then off
 * again with the Space key.
 */
export const Toggles = meta.story({
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
})

/**
 * Automatic upgrades switch of a Workspace, seen by a member who is not an
 * admin: the setting is on, and the switch is disabled, so a press does not
 * change it.
 */
export const Disabled = meta.story({
  render: () => <Controlled defaultSelected isDisabled />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole("switch", { name: "Automatic upgrades" })
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeDisabled()
    await userEvent.click(toggle, { pointerEventsCheck: 0 })
    await waitFor(() => expect(toggle).toBeChecked())
  },
})
