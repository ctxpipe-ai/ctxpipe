import type { Meta, StoryObj } from "@storybook/react-vite"
import { type CSSProperties, use, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { Button } from "./Button"
import {
  PageBodySkeleton,
  SKELETON_DELAY_MS,
  SKELETON_MIN_MS,
  Skeleton,
  SkeletonChain,
  SkeletonLine,
  SkeletonRegion,
  SkeletonRow,
  SkeletonSuspense,
  useSkeletonHold,
} from "./Skeleton"
import { installManualClock } from "./skeletonClockStory"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const bones = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-skeleton]"),
]

const allVisible = (root: HTMLElement) =>
  bones(root).length > 0 &&
  bones(root).every((bone) => getComputedStyle(bone).visibility === "visible")

/** Wait until the CSS delay of every bone has ended. */
const waitUntilVisible = async (root: HTMLElement) => {
  const deadline = performance.now() + SKELETON_DELAY_MS * 2
  while (!allVisible(root)) {
    if (performance.now() > deadline) throw new Error("Bones stayed hidden")
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
}

const allHidden = (root: HTMLElement) =>
  bones(root).length > 0 &&
  bones(root).every((bone) => getComputedStyle(bone).visibility === "hidden")

const meta = {
  title: "Components/Skeleton",
  component: Skeleton,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof Skeleton>

export default meta

type Story = StoryObj<typeof meta>

export const Bone: Story = {
  args: {
    className: "h-4 w-40",
  },
}

export const Row: Story = {
  render: () => (
    <div className="w-64 bg-zinc-950 py-2">
      <SkeletonRow />
    </div>
  ),
}

export const NavList: Story = {
  render: () => (
    <div className="w-64 space-y-0.5 bg-zinc-950 py-2" aria-busy>
      <span className="sr-only">Loading workspaces</span>
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </div>
  ),
}

export const Catalog: Story = {
  render: () => (
    <div className="w-md divide-y divide-white/[0.06] bg-zinc-950" aria-busy>
      <span className="sr-only">Loading connectors</span>
      <SkeletonRow size="catalog" />
      <SkeletonRow size="catalog" />
      <SkeletonRow size="catalog" />
    </div>
  ),
}

export const PageBody: Story = {
  render: () => (
    <div className="w-md bg-zinc-950 p-8">
      <PageBodySkeleton label="Loading page" />
    </div>
  ),
}

export const Lines: Story = {
  render: () => (
    <div className="flex w-80 flex-col gap-2">
      <SkeletonLine className="h-4 w-full" />
      <SkeletonLine className="h-4 w-[80%]" />
      <SkeletonLine className="h-4 w-[60%]" />
    </div>
  ),
}

/**
 * The CSS wait animation that runs the delay. The play test sets its time
 * itself, so it does not depend on the wall clock.
 */
const waitAnimation = (bone: HTMLElement) => {
  const wait = bone
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSAnimation &&
        animation.animationName === "ctx-skeleton-wait",
    )
  if (!wait) throw new Error("The bone has no wait animation")
  return wait
}

/**
 * No bone shows before the delay; the row keeps its final box all the time.
 * The play test pauses the wait animation and sets its time: one millisecond
 * before the delay the bones are hidden, at the delay they show.
 */
export const WaitsForDelay: Story = {
  tags: ["workspace-golden"],
  render: () => (
    <div className="w-64 bg-zinc-950" data-testid="row">
      <SkeletonRow />
    </div>
  ),
  play: async ({ canvasElement, mount }) => {
    await mount()
    await document.fonts.ready
    const row = within(canvasElement).getByTestId("row")
    const height = row.getBoundingClientRect().height
    expect(height).toBe(32)
    const animations = bones(canvasElement).map(waitAnimation)
    expect(animations.length).toBeGreaterThan(0)
    for (const animation of animations) {
      expect(animation.effect?.getComputedTiming().duration).toBe(
        SKELETON_DELAY_MS,
      )
      animation.pause()
      animation.currentTime = 0
    }
    expect(allHidden(canvasElement)).toBe(true)
    for (const animation of animations) {
      animation.currentTime = SKELETON_DELAY_MS - 1
    }
    expect(allHidden(canvasElement)).toBe(true)
    for (const animation of animations) {
      animation.currentTime = SKELETON_DELAY_MS
    }
    expect(allVisible(canvasElement)).toBe(true)
    expect(row.getBoundingClientRect().height).toBe(height)
  },
}

function HoldDemo() {
  const [pending, setPending] = useState(false)
  const showSkeleton = useSkeletonHold(pending)
  return (
    <div className="w-64 space-y-2 bg-zinc-950">
      <Button variant="outline" onPress={() => setPending(true)}>
        Start loading
      </Button>
      <Button variant="outline" onPress={() => setPending(false)}>
        Finish loading
      </Button>
      {showSkeleton ? <SkeletonRow /> : <p className="h-8">Loaded</p>}
    </div>
  )
}

const button = (canvasElement: HTMLElement, name: string) =>
  within(canvasElement).getByRole("button", { name })

/**
 * The three hold stories below run on a manual clock (`skeletonClockStory`),
 * so they do not depend on the speed of the machine.
 *
 * A load that ends before the delay shows the content at once.
 */
export const FastLoadSkipsSkeleton: Story = {
  tags: ["workspace-golden"],
  render: () => <HoldDemo />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      await clock.advance(SKELETON_DELAY_MS - 100)
      expect(bones(canvasElement).length).toBeGreaterThan(0)
      await clock.press(button(canvasElement, "Finish loading"))
      // The skeleton never showed, so there is no minimum hold: a hook that
      // always holds fails here.
      expect(canvas.getByText("Loaded")).toBeVisible()
      expect(bones(canvasElement)).toHaveLength(0)
    } finally {
      clock.restore()
    }
  },
}

/**
 * A visible skeleton stays until `SKELETON_MIN_MS` after it showed, not after
 * the data arrived.
 */
export const VisibleSkeletonHoldsMinimum: Story = {
  tags: ["workspace-golden"],
  render: () => <HoldDemo />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      // The skeleton shows at the delay. The data arrives 10 ms later.
      await clock.advance(SKELETON_DELAY_MS + 10)
      await clock.press(button(canvasElement, "Finish loading"))
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument() // play-timing: ok the manual clock drives every timer; no request is pending
      await clock.advance(SKELETON_MIN_MS - 11)
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument() // play-timing: ok the manual clock drives every timer; no request is pending
      expect(bones(canvasElement).length).toBeGreaterThan(0)
      await clock.advance(1)
      expect(canvas.getByText("Loaded")).toBeVisible()
    } finally {
      clock.restore()
    }
  },
}

/** After the hold ended, a later end of the load shows the content at once. */
export const NoSecondHoldAfterMinimum: Story = {
  tags: ["workspace-golden"],
  render: () => <HoldDemo />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      await clock.advance(SKELETON_DELAY_MS + SKELETON_MIN_MS + 10)
      await clock.press(button(canvasElement, "Finish loading"))
      // Only a timer of 0 ms is left: the hold is over, so no new hold starts.
      await clock.advance(0)
      expect(canvas.getByText("Loaded")).toBeVisible()
      expect(bones(canvasElement)).toHaveLength(0)
    } finally {
      clock.restore()
    }
  },
}

let release: () => void = () => {}
let content: Promise<void> = Promise.resolve()

function SuspendingContent() {
  use(content)
  return <p className="h-8">Loaded</p>
}

function SuspenseDemo() {
  const [started, setStarted] = useState(false)
  return (
    <div className="w-64 bg-zinc-950">
      <Button variant="outline" onPress={() => setStarted(true)}>
        Start loading
      </Button>
      {started ? (
        <SkeletonSuspense fallback={<SkeletonRow />}>
          <SuspendingContent />
        </SkeletonSuspense>
      ) : null}
    </div>
  )
}

/** `SkeletonSuspense` holds a visible fallback for the minimum time. */
export const SuspenseHoldsMinimum: Story = {
  tags: ["workspace-golden"],
  render: () => <SuspenseDemo />,
  play: async ({ canvasElement, mount }) => {
    content = new Promise((resolve) => {
      release = resolve
    })
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      // The fallback shows at the delay. The content is ready 10 ms later.
      await clock.advance(SKELETON_DELAY_MS + 10)
      release()
      await clock.advance(0)
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument() // play-timing: ok the manual clock drives every timer; no request is pending
      await clock.advance(SKELETON_MIN_MS - 11)
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument() // play-timing: ok the manual clock drives every timer; no request is pending
      await clock.advance(1)
      expect(canvas.getByText("Loaded")).toBeVisible()
    } finally {
      clock.restore()
    }
  },
}

/**
 * CSS starts the delay, so it runs from the first paint of server HTML, not
 * from hydration.
 */
export const DelayStartsAtFirstPaint: Story = {
  tags: ["workspace-golden"],
  render: () => (
    <div className="w-64 bg-zinc-950">
      <SkeletonRow />
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const bone of bones(canvasElement)) {
      expect(getComputedStyle(bone).animationName).toBe("ctx-skeleton-wait")
      expect(getComputedStyle(bone).visibility).toBe("hidden")
    }
  },
}

function HandOverDemo(props: { firstStyle?: CSSProperties; idle?: boolean }) {
  return (
    <SkeletonRegion>
      <HandOverDemoBody {...props} />
    </SkeletonRegion>
  )
}

function HandOverDemoBody(props: {
  firstStyle?: CSSProperties
  idle?: boolean
}) {
  const [step, setStep] = useState<"idle" | "first" | "second" | "query">(
    props.idle ? "idle" : "first",
  )
  const [pending, setPending] = useState(true)
  const [quick, setQuick] = useState(false)
  const showQuerySkeleton = useSkeletonHold(step === "query" && pending, "demo")
  return (
    <div className="w-64 space-y-2 bg-zinc-950">
      {props.idle ? (
        <Button variant="outline" onPress={() => setStep("first")}>
          Start loading
        </Button>
      ) : null}
      <Button variant="outline" onPress={() => setStep("second")}>
        Hand over
      </Button>
      <Button variant="outline" onPress={() => setStep("query")}>
        Hand over to a query
      </Button>
      <Button variant="outline" onPress={() => setPending(false)}>
        Finish loading
      </Button>
      <Button variant="outline" onPress={() => setQuick((value) => !value)}>
        Quick load
      </Button>
      {step === "idle" ? null : step === "first" ? (
        <div data-testid="first">
          <SkeletonChain id="demo">
            <Skeleton className="block h-8 w-full" style={props.firstStyle} />
          </SkeletonChain>
        </div>
      ) : step === "second" ? (
        <section key="second" data-testid="second">
          <SkeletonChain id="demo">
            <SkeletonRow size="catalog" />
          </SkeletonChain>
        </section>
      ) : (
        <article key="query" data-testid="query">
          {showQuerySkeleton ? (
            <SkeletonChain id="demo">
              <SkeletonRow size="catalog" />
            </SkeletonChain>
          ) : (
            <p className="h-8">Loaded</p>
          )}
        </article>
      )}
      {quick ? (
        <aside data-testid="quick">
          <SkeletonChain id="other">
            <SkeletonRow />
          </SkeletonChain>
        </aside>
      ) : null}
    </div>
  )
}

/** A visible skeleton that hands over to another one never goes blank. */
export const HandOverStaysVisible: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(allVisible(canvasElement)).toBe(true), {
      timeout: SKELETON_DELAY_MS * 2,
    })
    await userEvent.click(canvas.getByRole("button", { name: "Hand over" }))
    expect(canvas.getByTestId("second")).toBeInTheDocument()
    for (let frame = 0; frame < 20; frame += 1) {
      expect(allVisible(canvasElement)).toBe(true)
      await sleep(25)
    }
  },
}

/**
 * The next three stories run on a manual clock (`skeletonClockStory`). The
 * wait of a skeleton that follows another one is in its `--skeleton-wait`
 * style, so the play test reads the wait instead of timing the screen.
 */
const waitOf = (bone: HTMLElement) =>
  Number.parseFloat(bone.style.getPropertyValue("--skeleton-wait"))

/** A hand-over before the delay keeps the first start time. */
export const HandOverKeepsDelayStart: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo idle />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      await clock.advance(SKELETON_DELAY_MS / 2)
      await clock.press(button(canvasElement, "Hand over"))
      const [bone] = bones(canvas.getByTestId("second"))
      // 500 ms of the delay are over, so the next skeleton waits for the
      // rest. A skeleton that starts the delay again waits 1000 ms.
      expect(waitOf(bone)).toBeGreaterThan(SKELETON_DELAY_MS / 2 - 100)
      expect(waitOf(bone)).toBeLessThanOrEqual(SKELETON_DELAY_MS / 2)
    } finally {
      clock.restore()
    }
  },
}

/** A fast load in another chain of the region does not inherit the start. */
export const UnrelatedLoadKeepsItsDelay: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitUntilVisible(canvas.getByTestId("first"))
    await userEvent.click(canvas.getByRole("button", { name: "Quick load" }))
    const quick = canvas.getByTestId("quick")
    for (let frame = 0; frame < 6; frame += 1) {
      expect(allHidden(quick)).toBe(true)
      await sleep(25)
    }
    await userEvent.click(canvas.getByRole("button", { name: "Quick load" }))
    expect(canvas.queryByTestId("quick")).not.toBeInTheDocument()
  },
}

/** A query skeleton that takes over a visible one holds from that moment. */
export const HandOverHoldsMinimum: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo idle />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      // The area shows a skeleton from the delay; the hold counts from there.
      await clock.advance(SKELETON_DELAY_MS + 10)
      await clock.press(button(canvasElement, "Hand over to a query"))
      expect(bones(canvas.getByTestId("query")).length).toBeGreaterThan(0)
      await clock.press(button(canvasElement, "Finish loading"))
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
      // The skeleton showed 10 ms before the data. The hold ends 300 ms
      // after the skeleton showed, so 290 ms after the data.
      await clock.advance(SKELETON_MIN_MS - 50)
      expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
      await clock.advance(100)
      expect(canvas.getByText("Loaded")).toBeVisible()
    } finally {
      clock.restore()
    }
  },
}

/**
 * The chain start comes from the CSS animation of the first bone, not from
 * its React mount. Here the first bone's wait began 600 ms before the mount,
 * as server HTML does before hydration, so the successor waits only the
 * 400 ms that are left.
 */
export const HandOverUsesPaintStart: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo idle firstStyle={{ animationDelay: "-600ms" }} />,
  play: async ({ canvasElement, mount }) => {
    await mount()
    const clock = installManualClock()
    try {
      const canvas = within(canvasElement)
      await clock.press(button(canvasElement, "Start loading"))
      await clock.press(button(canvasElement, "Hand over"))
      const [bone] = bones(canvas.getByTestId("second"))
      expect(waitOf(bone)).toBeGreaterThan(SKELETON_DELAY_MS - 700)
      expect(waitOf(bone)).toBeLessThanOrEqual(SKELETON_DELAY_MS - 600)
    } finally {
      clock.restore()
    }
  },
}
