import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { NodeDetailDrawer } from "./NodeDetailDrawer"
import { colorForKind } from "./theme"
import type { KnowledgeGraphNode, NodeFacts } from "./types"

const linear: KnowledgeGraphNode = {
  id: "kn_linear",
  path: "knowledge/connectors/linear.md",
  kind: "Integration",
  name: "Linear",
  summary: "Issue mirror into knowledge/",
}

const gitCanonical: KnowledgeGraphNode = {
  id: "kn_git",
  path: "knowledge/hydrate/git.md",
  kind: "Pattern",
  name: "git canonical",
  summary: "Files are identity; hydrate does not write git",
}

const observedAt = Date.parse("2026-07-21T11:00:00.000Z")

const linearFacts: NodeFacts = {
  inDegree: 0,
  outDegree: 1,
  predicateCounts: new Map([["mirrors_into", 1]]),
  firstObserved: observedAt,
  lastObserved: observedAt,
  neighborKindCounts: new Map([["Pattern", 1]]),
  claims: [
    {
      predicate: "mirrors_into",
      neighborId: gitCanonical.id,
      direction: "out",
      confidence: 0.76,
      observedAt,
    },
  ],
}

const nodeById = new Map<string, KnowledgeGraphNode>([
  [linear.id, linear],
  [gitCanonical.id, gitCanonical],
])

const kindColors = new Map<string, string>([
  ["Integration", colorForKind("Integration")],
  ["Pattern", colorForKind("Pattern")],
])

const meta = {
  title: "Components/Knowledge Graph/Node Detail",
  component: NodeDetailDrawer,
  decorators: [
    (Story) => (
      <div className="relative h-[40rem] w-full max-w-lg overflow-hidden bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", review: { kind: "component" } },
  args: {
    node: linear,
    facts: linearFacts,
    kindColor: colorForKind("Integration"),
    kindColors,
    nodeById,
    peerDegrees: [1, 1, 3],
    open: true,
    onClose: fn(),
    onFocus: fn(),
    onNeighborSelect: fn(),
    onOpenSource: fn(),
  },
} satisfies Meta<typeof NodeDetailDrawer>

export default meta

type Story = StoryObj<typeof meta>

/** Section labels use the mono label style. A faint hairline separates each
 * section from the one above it; the first section has no line. */
export const Populated: Story = {
  parameters: {
    review: {
      purpose:
        "Node drawer of the knowledge graph, which opens when the user clicks a node: an integration node with one outgoing link, its path, summary, activity and links.",
    },
  },
  play: async ({ canvasElement }) => {
    const headings = within(canvasElement).getAllByRole("heading", {
      level: 3,
    })
    await expect(headings[0]).toHaveTextContent("Path")
    for (const heading of headings) {
      await expect(heading).toHaveClass("ctx-label")
    }
    const sections = headings.map((heading) => heading.closest("section"))
    const borderTop = (section: Element | null) =>
      getComputedStyle(section as Element).borderTopWidth
    await expect(borderTop(sections[0])).toBe("0px")
    for (const section of sections.slice(1)) {
      await expect(borderTop(section)).toBe("1px")
    }
    // The one claim is on one day, and the buckets cover a week from it: the
    // two axis dates differ.
    const activity = headings
      .find((heading) => heading.textContent === "Activity")
      ?.closest("section")
    await waitFor(() => {
      const dates = [...(activity?.querySelectorAll("svg text") ?? [])]
        .map((label) => label.textContent ?? "")
        .filter((label) => /[A-Za-z]/.test(label))
      expect(new Set(dates).size).toBe(2)
    })
  },
}

/** The node id is a `kn_` id; the Path row shows the file and links to it. */
export const SourceLink: Story = {
  parameters: {
    review: {
      purpose:
        "Node detail drawer of the knowledge graph, which tells a user about one node and its links: the user pressed Go to definition on the file path.",
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("knowledge/connectors/linear.md"),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Go to definition" }),
    )
    await expect(args.onOpenSource).toHaveBeenCalledWith(
      "knowledge/connectors/linear.md",
    )
  },
}

export const Isolated: Story = {
  parameters: {
    review: {
      purpose:
        "Node detail drawer of the knowledge graph, which tells a user about one node and its links: the node has few peers to compare its degree with.",
    },
  },
  args: {
    peerDegrees: [1],
  },
}
