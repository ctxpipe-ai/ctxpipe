import { describe, expect, test } from "vitest"

import {
  judgementJsonSchema,
  parseVerdict,
  verdictSchema,
  type StoryInput,
} from "./index.ts"

const story: StoryInput = {
  storyId: "connectors-catalog--default",
  scope: "component",
  viewport: { width: 1440, height: 900 },
  regions: [
    {
      box: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      changeType: "content-change",
      position: "top-left",
      confidence: 0.9,
    },
  ],
  images: [{ role: "regions", path: "regions.png" }],
  brief: "Rename the button to Add connection.",
  sourceDiff: "-  <Button>Connect</Button>\n+  <Button>Add connection</Button>",
}
const run = {
  model: "anthropic/claude-sonnet-5.5",
  costUsd: 0.004,
  latencyMs: 2100,
}

const judgement = {
  observations: [
    {
      region: 1,
      before: "A white button with the word Connect.",
      after: "A white button with the words Add connection.",
    },
  ],
  verdict: "intended",
  severity: "none",
  confidence: 0.8,
  summary: "The button label changed as the brief asks.",
  qualities: [{ name: "clarity", delta: "better", confidence: 0.7 }],
  findings: [
    {
      kind: "typography",
      region: { x: 0.1, y: 0.2, width: 0.3, height: 0.05 },
      evidence: "The label is now Add connection.",
      rubricRef: "apps/ui/DESIGN.md › Personality (copy these)",
      explainedByBrief: true,
      suggestion: null,
    },
  ],
}

describe("parseVerdict", () => {
  test("text that is not JSON gives unsure with the parse error", () => {
    const verdict = parseVerdict("The change looks fine to me.", story, run)

    expect(verdict).toMatchObject({
      storyId: "connectors-catalog--default",
      verdict: "unsure",
      severity: "none",
      confidence: 0,
      qualities: [],
      findings: [],
      model: "anthropic/claude-sonnet-5.5",
      costUsd: 0.004,
      latencyMs: 2100,
    })
    expect(verdict.error).toMatch(/JSON/)
  })

  test("JSON that breaks the schema gives unsure with the field that is wrong", () => {
    const text = JSON.stringify({ ...judgement, verdict: "looks-good" })

    const verdict = parseVerdict(text, story, run)

    expect(verdict.verdict).toBe("unsure")
    expect(verdict.error).toMatch(/verdict/)
  })

  test("a valid judgement keeps its fields and gets the story id and run facts", () => {
    const verdict = parseVerdict(JSON.stringify(judgement), story, run)

    expect(verdict).toEqual({
      storyId: "connectors-catalog--default",
      ...judgement,
      ...run,
    })
  })

  test("a judgement in a markdown code fence is read", () => {
    const text = `\`\`\`json\n${JSON.stringify(judgement)}\n\`\`\``

    expect(parseVerdict(text, story, run).verdict).toBe("intended")
  })

  test("intended without a brief or a source diff becomes unsure", () => {
    const verdict = parseVerdict(
      JSON.stringify(judgement),
      { ...story, brief: undefined, sourceDiff: undefined },
      run,
    )

    expect(verdict.verdict).toBe("unsure")
    expect(verdict.summary).toMatch(/no brief or source diff/i)
  })

  test("intended with a finding that the brief does not explain becomes unsure", () => {
    const text = JSON.stringify({
      ...judgement,
      findings: [{ ...judgement.findings[0], explainedByBrief: false }],
    })

    const verdict = parseVerdict(text, story, run)

    expect(verdict.verdict).toBe("unsure")
    expect(verdict.summary).toMatch(/not explained/i)
  })

  test("a page-only quality is dropped when the scope is not page", () => {
    const text = JSON.stringify({
      ...judgement,
      qualities: [
        { name: "focus", delta: "worse", confidence: 0.6 },
        { name: "clarity", delta: "same", confidence: 0.9 },
      ],
    })

    expect(parseVerdict(text, story, run).qualities).toEqual([
      { name: "clarity", delta: "same", confidence: 0.9 },
    ])
    expect(
      parseVerdict(text, { ...story, scope: "page" }, run).qualities,
    ).toHaveLength(2)
  })

  test("each verdict that the parser gives, usable or not, matches the verdict schema", () => {
    const verdicts = [
      parseVerdict(JSON.stringify(judgement), story, run),
      parseVerdict("not JSON", story, run),
      parseVerdict(
        JSON.stringify(judgement),
        { ...story, brief: undefined, sourceDiff: undefined },
        {
          ...run,
          costUsd: null,
        },
      ),
    ]

    for (const verdict of verdicts)
      expect(verdictSchema.safeParse(verdict).error).toBeUndefined()
  })

  test("the verdict schema rejects a stored verdict without its story id or run facts", () => {
    const result = verdictSchema.safeParse(judgement)

    expect(result.success).toBe(false)
    expect(result.error?.issues.map(({ path }) => path.join("."))).toEqual(
      expect.arrayContaining(["storyId", "model", "latencyMs"]),
    )
  })

  test("the JSON schema fits strict structured output: every field is required, no extra field is allowed", () => {
    const loose: string[] = []
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return
      const schema = node as Record<string, unknown>
      if (schema.type === "object") {
        const keys = Object.keys(schema.properties as object)
        if (schema.additionalProperties !== false)
          loose.push(`${path} allows extra fields`)
        for (const key of keys)
          if (!(schema.required as string[]).includes(key))
            loose.push(`${path}.${key} is optional`)
      }
      for (const [key, child] of Object.entries(schema))
        walk(child, `${path}.${key}`)
    }

    walk(judgementJsonSchema, "$")

    expect(loose).toEqual([])
    expect(judgementJsonSchema.required).toEqual([
      "observations",
      "verdict",
      "severity",
      "confidence",
      "summary",
      "qualities",
      "findings",
    ])
  })

  test("a finding box outside 0..1 breaks the schema", () => {
    const text = JSON.stringify({
      ...judgement,
      findings: [
        {
          ...judgement.findings[0],
          region: { x: 120, y: 40, width: 300, height: 20 },
        },
      ],
    })

    const verdict = parseVerdict(text, story, run)

    expect(verdict.verdict).toBe("unsure")
    expect(verdict.error).toMatch(/region/)
  })
})
