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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const bones = (root: HTMLElement) => [
  ...root.querySelectorAll<HTMLElement>("[data-skeleton]"),
]

const allVisible = (root: HTMLElement) =>
  bones(root).length > 0 &&
  bones(root).every((bone) => getComputedStyle(bone).visibility === "visible")

/** The time the bones became visible, read on each animation frame. */
const visibleAt = async (root: HTMLElement) => {
  const deadline = performance.now() + SKELETON_DELAY_MS * 2
  while (!allVisible(root)) {
    if (performance.now() > deadline) throw new Error("Bones stayed hidden")
    await new Promise((resolve) => requestAnimationFrame(resolve))
  }
  return performance.now()
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

/** No bone shows before the delay; the row keeps its final box all the time. */
export const WaitsForDelay: Story = {
  tags: ["workspace-golden"],
  render: () => (
    <div className="w-64 bg-zinc-950" data-testid="row">
      <SkeletonRow />
    </div>
  ),
  play: async ({ canvasElement, mount }) => {
    const mountedAt = performance.now()
    await mount()
    const row = within(canvasElement).getByTestId("row")
    const height = row.getBoundingClientRect().height
    expect(height).toBe(32)
    expect(allHidden(canvasElement)).toBe(true)
    await sleep(SKELETON_DELAY_MS - 200 - (performance.now() - mountedAt))
    expect(allHidden(canvasElement)).toBe(true)
    await waitFor(() => expect(allVisible(canvasElement)).toBe(true), {
      timeout: SKELETON_DELAY_MS,
    })
    expect(performance.now() - mountedAt).toBeGreaterThanOrEqual(
      SKELETON_DELAY_MS,
    )
    expect(row.getBoundingClientRect().height).toBe(height)
  },
}

function HoldDemo() {
  const [pending, setPending] = useState(true)
  const showSkeleton = useSkeletonHold(pending)
  return (
    <div className="w-64 space-y-2 bg-zinc-950">
      <Button variant="outline" onPress={() => setPending(false)}>
        Finish loading
      </Button>
      {showSkeleton ? <SkeletonRow /> : <p className="h-8">Loaded</p>}
    </div>
  )
}

/** A load that ends before the delay shows the content at once. */
export const FastLoadSkipsSkeleton: Story = {
  tags: ["workspace-golden"],
  render: () => <HoldDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The hidden skeleton keeps its box before the click.
    expect(allHidden(canvasElement)).toBe(true)
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" }),
    )
    // No minimum hold: the skeleton never showed, so a hook that always
    // holds fails here.
    expect(canvas.getByText("Loaded")).toBeVisible()
    expect(bones(canvasElement)).toHaveLength(0)
  },
}

/** A visible skeleton stays for the minimum time after the data arrives. */
export const VisibleSkeletonHoldsMinimum: Story = {
  tags: ["workspace-golden"],
  render: () => <HoldDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const shownAt = await visibleAt(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" }),
    )
    expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
    expect(allVisible(canvasElement)).toBe(true)
    await waitFor(() => expect(canvas.getByText("Loaded")).toBeVisible(), {
      timeout: SKELETON_MIN_MS * 3,
    })
    expect(performance.now() - shownAt).toBeGreaterThanOrEqual(
      SKELETON_MIN_MS - 20,
    )
  },
}

let release: () => void = () => {}
let content: Promise<void> = Promise.resolve()

function SuspendingContent() {
  use(content)
  return <p className="h-8">Loaded</p>
}

function SuspenseDemo() {
  return (
    <div className="w-64 bg-zinc-950">
      <SkeletonSuspense fallback={<SkeletonRow />}>
        <SuspendingContent />
      </SkeletonSuspense>
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
    const canvas = within(canvasElement)
    const shownAt = await visibleAt(canvasElement)
    release()
    await sleep(SKELETON_MIN_MS / 3)
    expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
    await waitFor(() => expect(canvas.getByText("Loaded")).toBeVisible(), {
      timeout: SKELETON_MIN_MS * 3,
    })
    // Measured from the frame where the skeleton became visible.
    expect(performance.now() - shownAt).toBeGreaterThanOrEqual(
      SKELETON_MIN_MS - 20,
    )
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

function HandOverDemo(props: { firstStyle?: CSSProperties }) {
  return (
    <SkeletonRegion>
      <HandOverDemoBody {...props} />
    </SkeletonRegion>
  )
}

function HandOverDemoBody(props: { firstStyle?: CSSProperties }) {
  const [step, setStep] = useState<"first" | "second" | "query">("first")
  const [pending, setPending] = useState(true)
  const [quick, setQuick] = useState(false)
  const showQuerySkeleton = useSkeletonHold(step === "query" && pending, "demo")
  return (
    <div className="w-64 space-y-2 bg-zinc-950">
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
      {step === "first" ? (
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

/** A hand-over before the delay keeps the first start time. */
export const HandOverKeepsDelayStart: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo />,
  play: async ({ canvasElement, mount }) => {
    const mountedAt = performance.now()
    await mount()
    const canvas = within(canvasElement)
    await sleep(SKELETON_DELAY_MS / 2 - (performance.now() - mountedAt))
    await userEvent.click(canvas.getByRole("button", { name: "Hand over" }))
    expect(allHidden(canvasElement)).toBe(true)
    await waitFor(() => expect(allVisible(canvasElement)).toBe(true), {
      timeout: SKELETON_DELAY_MS * 2,
    })
    expect(performance.now() - mountedAt).toBeLessThan(SKELETON_DELAY_MS + 250)
  },
}

/** A fast load in another chain of the region does not inherit the start. */
export const UnrelatedLoadKeepsItsDelay: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visibleAt(canvas.getByTestId("first"))
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
  render: () => <HandOverDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await visibleAt(canvas.getByTestId("first"))
    await userEvent.click(
      canvas.getByRole("button", { name: "Hand over to a query" }),
    )
    const handedOverAt = performance.now()
    expect(allVisible(canvas.getByTestId("query"))).toBe(true)
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" }),
    )
    expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
    await waitFor(() => expect(canvas.getByText("Loaded")).toBeVisible(), {
      timeout: SKELETON_MIN_MS * 3,
    })
    expect(performance.now() - handedOverAt).toBeGreaterThanOrEqual(
      SKELETON_MIN_MS - 20,
    )
  },
}

/**
 * The chain start comes from the CSS animation of the first bone, not from
 * its React mount. Here the first bone's wait began 600 ms before the mount,
 * as server HTML does before hydration, so the successor shows at about
 * 400 ms.
 */
export const HandOverUsesPaintStart: Story = {
  tags: ["workspace-golden"],
  render: () => <HandOverDemo firstStyle={{ animationDelay: "-600ms" }} />,
  play: async ({ canvasElement, mount }) => {
    const mountedAt = performance.now()
    await mount()
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Hand over" }))
    await visibleAt(canvas.getByTestId("second"))
    expect(performance.now() - mountedAt).toBeLessThan(SKELETON_DELAY_MS - 300)
  },
}
