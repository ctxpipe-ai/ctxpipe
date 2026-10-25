import type { ReactNode } from "react"
import { expect, waitFor, within } from "storybook/test"

import { cn } from "@/lib/utils"

/**
 * Story-only frame: the skeleton and the loaded state in two boxes of the
 * same width (and height, for a pane), so a play test can compare them.
 */
export function SkeletonMatchFrame(props: {
  skeleton: ReactNode
  loaded: ReactNode
  className?: string
}) {
  return (
    <div className="flex flex-col gap-8 bg-zinc-950">
      <div
        data-testid="skeleton-box"
        className={cn("flow-root", props.className)}
      >
        {props.skeleton}
      </div>
      <div
        data-testid="loaded-box"
        className={cn("flow-root", props.className)}
      >
        {props.loaded}
      </div>
    </div>
  )
}

const outerBox = (frame: HTMLElement) => {
  const content = frame.firstElementChild
  if (!content) throw new Error(`${frame.dataset.testid} is empty`)
  const { width, height } = content.getBoundingClientRect()
  return { width: Math.round(width), height: Math.round(height) }
}

/** The skeleton's outer box has the same size as the loaded state's box. */
export async function expectSkeletonMatchesLoaded(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  const loaded = await canvas.findByTestId("loaded-box")
  const skeleton = canvas.getByTestId("skeleton-box")
  const loadedBox = outerBox(loaded)
  expect(loadedBox.height).toBeGreaterThan(0)
  expect(outerBox(skeleton)).toEqual(loadedBox)
}

/**
 * A gate for an MSW handler: the response waits until the play calls
 * `release`, so the play can measure the loading layout first.
 */
export function responseGate() {
  let release: () => void = () => {}
  let requested = false
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    wait: () => {
      requested = true
      return opened
    },
    release: async () => {
      await waitFor(() => expect(requested).toBe(true))
      release()
    },
  }
}

/** The element keeps the same box when the data arrives. */
export async function expectBoxUnchanged(
  element: HTMLElement,
  arrive: () => Promise<void>,
) {
  const size = () => {
    const { width, height } = element.getBoundingClientRect()
    return { width: Math.round(width), height: Math.round(height) }
  }
  const before = size()
  expect(before.height).toBeGreaterThan(0)
  await arrive()
  expect(size()).toEqual(before)
}
