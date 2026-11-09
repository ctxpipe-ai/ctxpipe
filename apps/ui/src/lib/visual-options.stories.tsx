import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useRef, useState } from "react"
import { expect } from "storybook/test"

import { Button } from "@/components/ui/Button"

import { snapshot } from "./visual-snapshot"

// This story proves the screenshot options of a story
// (scripts/ci/visual-capture.mjs). Its play takes two named snapshots, so it
// has three baselines: `@closed`, `@menu-open` and the end state (saved). A clock and
// a canvas change on each frame. The clock has the `data-visual-mask`
// attribute, and `parameters.visual.masks` finds the canvas. Thus the capture
// hides both, and two runs give the same pixels. Without the masks, each
// shot differs and the story is `unstable`.

function Clock() {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 50)
    return () => clearInterval(timer)
  }, [])
  return (
    <time data-visual-mask className="font-mono">
      {now.toFixed(1)} ms
    </time>
  )
}

function Noise() {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let frame = 0
    const draw = () => {
      const context = canvas.current?.getContext("2d")
      if (context) {
        // performance.now() is not pinned, so each frame has other colors.
        const hue = Math.floor(performance.now()) % 360
        context.fillStyle = `hsl(${hue} 70% 50%)`
        context.fillRect(0, 0, 120, 40)
      }
      frame = requestAnimationFrame(draw)
    }
    draw()
    return () => cancelAnimationFrame(frame)
  }, [])
  return <canvas ref={canvas} data-testid="noise" width={120} height={40} />
}

function Card() {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)
  return (
    <div className="flex w-80 flex-col gap-3 p-4">
      <Clock />
      <Noise />
      <Button variant="secondary" onPress={() => setOpen(true)}>
        Open menu
      </Button>
      {open ? (
        <div role="group" aria-label="Actions" className="flex flex-col gap-2">
          <Button onPress={() => setSaved(true)}>Save</Button>
        </div>
      ) : null}
      {saved ? <p>Saved</p> : null}
    </div>
  )
}

const meta = {
  title: "Testing/Visual options",
  component: Card,
  parameters: {
    visual: { masks: ["[data-testid='noise']"] },
  },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const NamedSnapshots: Story = {
  play: async ({ canvas, userEvent }) => {
    await snapshot("closed")
    await userEvent.click(canvas.getByRole("button", { name: "Open menu" }))
    await expect(canvas.getByRole("group", { name: "Actions" })).toBeVisible()
    await snapshot("menu-open")
    // The end state, after the play, is the saved state.
    await userEvent.click(canvas.getByRole("button", { name: "Save" }))
    await expect(canvas.getByText("Saved")).toBeVisible()
  },
}
