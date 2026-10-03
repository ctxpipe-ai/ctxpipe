import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  PageBodySkeleton,
  Skeleton,
  SkeletonLine,
  SkeletonRow,
} from "./Skeleton"

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
