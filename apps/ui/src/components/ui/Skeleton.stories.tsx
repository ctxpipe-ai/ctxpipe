import type { Meta, StoryObj } from "@storybook/react-vite"
import { use, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./Button"
import {
  PageBodySkeleton,
  SKELETON_DELAY_MS,
  SKELETON_MIN_MS,
  Skeleton,
  SkeletonLine,
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
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" }),
    )
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
    await waitFor(() => expect(allVisible(canvasElement)).toBe(true), {
      timeout: SKELETON_DELAY_MS * 2,
    })
    const finishedAt = performance.now()
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" }),
    )
    expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
    expect(allVisible(canvasElement)).toBe(true)
    await waitFor(() => expect(canvas.getByText("Loaded")).toBeVisible(), {
      timeout: SKELETON_MIN_MS * 3,
    })
    expect(performance.now() - finishedAt).toBeGreaterThanOrEqual(
      SKELETON_MIN_MS - 50,
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
    await waitFor(() => expect(allVisible(canvasElement)).toBe(true), {
      timeout: SKELETON_DELAY_MS * 2,
    })
    const releasedAt = performance.now()
    release()
    await sleep(SKELETON_MIN_MS / 3)
    expect(canvas.queryByText("Loaded")).not.toBeInTheDocument()
    await waitFor(() => expect(canvas.getByText("Loaded")).toBeVisible(), {
      timeout: SKELETON_MIN_MS * 3,
    })
    expect(performance.now() - releasedAt).toBeGreaterThanOrEqual(
      SKELETON_MIN_MS - 50,
    )
  },
}
