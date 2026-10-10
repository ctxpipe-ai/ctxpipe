import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { NodeDetailDrawer } from "./NodeDetailDrawer"
import { colorForKind } from "./theme"
import type { KnowledgeGraphNode, NodeFacts } from "./types"

const linear: KnowledgeGraphNode = {
  id: "knowledge/connectors/linear.md",
  kind: "Integration",
  name: "Linear",
  summary: "Issue mirror into knowledge/",
}

const gitCanonical: KnowledgeGraphNode = {
  id: "knowledge/hydrate/git.md",
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
  neighbourKindCounts: new Map([["Pattern", 1]]),
  claims: [
    {
      predicate: "mirrors_into",
      neighbourId: gitCanonical.id,
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
  parameters: { layout: "fullscreen" },
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
    onNeighbourSelect: fn(),
    onOpenSource: fn(),
  },
} satisfies Meta<typeof NodeDetailDrawer>

export default meta

type Story = StoryObj<typeof meta>

export const Populated: Story = {}

export const Isolated: Story = {
  args: {
    peerDegrees: [1],
  },
}

export const Closed: Story = {
  args: {
    open: false,
  },
}
