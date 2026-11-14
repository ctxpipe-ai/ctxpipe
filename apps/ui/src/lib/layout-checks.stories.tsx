import type { Meta, StoryObj } from "@storybook/react-vite"
import { IconCheck, IconInfoCircle } from "@tabler/icons-react"
import { expect } from "storybook/test"

import { type LayoutRule, layoutProblems } from "./layout-checks"

// These stories prove the layout checks of the screenshot capture
// (layout-checks.ts). For each rule, one story breaks the rule and one story
// has the fix. The play of each story runs the checks in the real browser.
// A story that breaks a rule accepts that rule in `parameters.visual.allow`,
// so its screenshot check passes; that proves the opt-out too.

const longUrl =
  "https://example-organization.atlassian.net/wiki/spaces/ENGINEERING/pages/1234567890/a-very-long-page-name"

function Alert({ breakUrl }: { breakUrl: boolean }) {
  return (
    <div
      role="alert"
      className="flex w-72 gap-3 rounded-md border border-zinc-700 bg-zinc-900 p-3 text-sm text-zinc-100"
    >
      <IconInfoCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <p>Could not load the capabilities of</p>
        <p className={breakUrl ? "break-all" : undefined}>{longUrl}</p>
        <p className="truncate">
          A long line that ends with an ellipsis, on purpose
        </p>
        <div className="h-12 overflow-y-auto">
          <p>A scroll box shows its overflow on purpose.</p>
          <p>Line two.</p>
          <p>Line three.</p>
          <p>Line four.</p>
        </div>
      </div>
    </div>
  )
}

// A wizard body: a header icon and a checklist. The boxes of the checklist
// and the icon have the same left edge; with `size-5` boxes, their centers
// are 2 px to the right of the center of the icon.
function Checklist({ box }: { box: "size-4" | "size-5" }) {
  return (
    <dialog
      open
      aria-label="Choose the scope"
      className="static m-0 flex w-96 flex-col gap-3 rounded-md border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-100"
    >
      <h2 className="flex items-center gap-2 font-medium">
        <IconInfoCircle className="size-4" aria-hidden />
        Choose the scope
      </h2>
      <ul className="flex flex-col gap-2">
        {["Issues", "Projects", "Documents"].map((name) => (
          <li key={name} className="flex items-center gap-2">
            <span
              className={`flex ${box} items-center justify-center rounded-md border border-zinc-400`}
            >
              <IconCheck className="size-3" aria-hidden />
            </span>
            {name}
          </li>
        ))}
      </ul>
      {/* A clearly indented column is a second axis, not an error. */}
      <p className="flex items-center gap-2 pl-6">
        <IconCheck className="size-4" aria-hidden />
        Nested detail
      </p>
    </dialog>
  )
}

function Text({ className }: { className: string }) {
  return (
    <div className="w-72 rounded-md bg-zinc-900 p-3">
      <p className={`text-sm ${className}`}>The last sync ended 2 hours ago.</p>
    </div>
  )
}

const meta = {
  title: "Testing/Layout checks",
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

const rules = async (root: Element) => {
  await document.fonts.ready
  return (await layoutProblems(root)).map((problem) => problem.rule)
}

const found = async (root: Element, rule: LayoutRule) => {
  const problems = await layoutProblems(root)
  return problems.filter((problem) => problem.rule === rule)
}

export const OverflowFound: Story = {
  render: () => <Alert breakUrl={false} />,
  parameters: {
    visual: {
      allow: {
        overflow: "A fixture that breaks the rule; its play proves the check.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const problems = await found(canvasElement, "overflow")
    // The paragraph with the URL; the alert around it is not named again.
    await expect(problems).toHaveLength(1)
    await expect(problems[0].element).toMatch(
      /^p "https:\/\/example-organization/,
    )
    await expect(problems[0].detail).toMatch(
      /^text runs [\d.]+ px past the right edge of its [\d.]+ px wide box$/,
    )
  },
}

export const OverflowFixed: Story = {
  render: () => <Alert breakUrl />,
  play: async ({ canvasElement }) => {
    // The ellipsis line and the scroll box overflow on purpose.
    await expect(await rules(canvasElement)).toEqual([])
  },
}

export const AxesFound: Story = {
  render: () => <Checklist box="size-5" />,
  parameters: {
    visual: {
      allow: {
        axes: "A fixture that breaks the rule; its play proves the check.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const problems = await found(canvasElement, "axes")
    await expect(problems).toHaveLength(1)
    await expect(problems[0].element).toMatch(
      /^dialog\[aria-label="Choose the scope"\]/,
    )
    await expect(problems[0].detail).toMatch(
      /^4 leading markers sit on 2 near axes \(center x [\d.]+, [\d.]+\): the centers differ by 2 px\. First: svg/,
    )
  },
}

export const AxesFixed: Story = {
  render: () => <Checklist box="size-4" />,
  play: async ({ canvasElement }) => {
    await expect(await rules(canvasElement)).toEqual([])
  },
}

export const ContrastFound: Story = {
  render: () => <Text className="text-zinc-600" />,
  parameters: {
    visual: {
      allow: {
        contrast: "A fixture that breaks the rule; its play proves the check.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const problems = await found(canvasElement, "contrast")
    await expect(problems).toHaveLength(1)
    await expect(problems[0].element).toBe(
      'p "The last sync ended 2 hours ago."',
    )
    await expect(problems[0].detail).toMatch(/is below 4\.5:1/)
  },
}

export const ContrastFixed: Story = {
  render: () => <Text className="text-zinc-300" />,
  play: async ({ canvasElement }) => {
    await expect(await rules(canvasElement)).toEqual([])
  },
}
