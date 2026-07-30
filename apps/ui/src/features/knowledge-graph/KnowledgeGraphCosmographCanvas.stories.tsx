import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { KnowledgeGraphCosmographCanvas } from "./KnowledgeGraphCosmographCanvas"

const meta = {
  title: "Components/Knowledge Graph/Cosmograph Canvas",
  component: KnowledgeGraphCosmographCanvas,
  decorators: [
    (Story) => (
      <div className="relative h-[min(44rem,100vh)] w-[min(72rem,100vw)] overflow-hidden bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  args: {
    onPointClick: fn(),
    onBackgroundClick: fn(),
    onSelectionChange: fn(),
    points: [
      {
        id: "auth",
        label: "Authentication",
        kind: "Capability",
        summary: "User identity and access",
        degree: 5,
      },
      {
        id: "api",
        label: "Public API",
        kind: "Service",
        summary: "HTTP application boundary",
        degree: 4,
      },
      {
        id: "worker",
        label: "Ingestion worker",
        kind: "Service",
        summary: "Repository processing",
        degree: 3,
      },
      {
        id: "postgres",
        label: "PostgreSQL",
        kind: "Technology",
        summary: "Primary persistence",
        degree: 3,
      },
      {
        id: "github",
        label: "GitHub",
        kind: "Integration",
        summary: "Repository source",
        degree: 2,
      },
      {
        id: "events",
        label: "Domain events",
        kind: "Pattern",
        summary: "Asynchronous coordination",
        degree: 1,
      },
    ],
    links: [
      {
        source: "api",
        target: "auth",
        predicate: "uses",
        confidence: 0.95,
        lastObservedAt: "2026-07-27T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-27T00:00:00.000Z"),
      },
      {
        source: "api",
        target: "postgres",
        predicate: "stores data in",
        confidence: 0.9,
        lastObservedAt: "2026-07-25T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-25T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "postgres",
        predicate: "stores data in",
        confidence: 0.88,
        lastObservedAt: "2026-07-24T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-24T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "github",
        predicate: "reads from",
        confidence: 0.85,
        lastObservedAt: "2026-07-22T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-22T00:00:00.000Z"),
      },
      {
        source: "worker",
        target: "events",
        predicate: "publishes",
        confidence: 0.72,
        lastObservedAt: "2026-07-20T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-20T00:00:00.000Z"),
      },
      {
        source: "auth",
        target: "github",
        predicate: "integrates with",
        confidence: 0.68,
        lastObservedAt: "2026-07-18T00:00:00.000Z",
        lastObservedAtMs: Date.parse("2026-07-18T00:00:00.000Z"),
      },
    ],
  },
} satisfies Meta<typeof KnowledgeGraphCosmographCanvas>

export default meta

type Story = StoryObj<typeof meta>

export const NativeLegends: Story = {}
