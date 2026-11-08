import { describe, expect, test } from "vitest"

import {
  knownRegion,
  planMutation,
  regressionClasses,
  seeded,
  type ElementFacts,
  type PageFacts,
} from "./mutations.ts"

const element = (facts: Partial<ElementFacts>): ElementFacts => ({
  box: { x: 100, y: 100, width: 200, height: 40 },
  tag: "div",
  text: false,
  textWidth: 0,
  inline: false,
  padding: 0,
  background: null,
  surface: [10, 10, 10],
  color: [250, 250, 250],
  focusable: false,
  focusRing: false,
  graphic: false,
  ...facts,
})

// A small dark page: the story root, a card, a label, an icon and a button.
const page: PageFacts = {
  viewport: { width: 1440, height: 900 },
  elements: [
    element({ box: { x: 0, y: 0, width: 1440, height: 900 } }),
    element({
      box: { x: 40, y: 40, width: 400, height: 240 },
      padding: 48,
      background: [37, 37, 37],
    }),
    element({
      box: { x: 64, y: 64, width: 180, height: 20 },
      text: true,
      textWidth: 150,
    }),
    element({
      box: { x: 64, y: 100, width: 16, height: 16 },
      tag: "svg",
      graphic: true,
    }),
    element({
      box: { x: 64, y: 200, width: 120, height: 36 },
      tag: "button",
      text: true,
      textWidth: 90,
      focusable: true,
      focusRing: true,
      padding: 24,
      background: [250, 250, 250],
      color: [30, 30, 30],
    }),
  ],
  tokens: [
    { name: "--destructive", rgb: [220, 40, 40] },
    { name: "--muted", rgb: [38, 38, 38] },
  ],
  lightTokens: { "--background": "oklch(1 0 0)", "--card": "oklch(1 0 0)" },
}

describe("planMutation", () => {
  test("has the eight regression classes of the plan", () => {
    expect(regressionClasses).toEqual([
      "padding",
      "color-token",
      "overflow",
      "truncated-text",
      "contrast-loss",
      "missing-element",
      "dark-surface",
      "focus-ring",
    ])
  })

  test("each class targets an element that can show it", () => {
    const targets = Object.fromEntries(
      regressionClasses.map((kind) => [
        kind,
        planMutation(kind, page, seeded(1))?.target,
      ]),
    )
    expect(targets).toEqual({
      padding: expect.toBeOneOf([1, 4]),
      "color-token": expect.toBeOneOf([1, 4]),
      overflow: expect.toBeOneOf([2, 4]),
      "truncated-text": expect.toBeOneOf([2, 4]),
      "contrast-loss": expect.toBeOneOf([2, 4]),
      "missing-element": expect.toBeOneOf([3, 4]),
      "dark-surface": 1,
      "focus-ring": 4,
    })
  })

  test("cuts the text of the target to less than its width", () => {
    const plan = planMutation(
      "truncated-text",
      { ...page, elements: page.elements.slice(0, 3) },
      seeded(1),
    )
    expect(plan?.style).toMatchObject({
      "max-width": "75px",
      overflow: "hidden",
      "text-overflow": "ellipsis",
    })
  })

  test("repeats the text of the target past the end of its box", () => {
    const plan = planMutation(
      "overflow",
      { ...page, elements: page.elements.slice(0, 3) },
      seeded(1),
    )
    expect(plan).toMatchObject({
      target: 2,
      repeatText: 5,
      style: { width: "150px", "white-space": "nowrap", overflow: "visible" },
    })
  })

  test("removes the focus ring only of an element that shows one", () => {
    const noRing = {
      ...page,
      elements: page.elements.map((entry) => ({ ...entry, focusRing: false })),
    }
    expect(planMutation("focus-ring", noRing, seeded(1))).toBeNull()
  })

  test("removes the padding of the target", () => {
    expect(planMutation("padding", page, seeded(1))?.style).toMatchObject({
      padding: "0px",
    })
  })

  test("gives the target a token that is far from its own color", () => {
    const plan = planMutation(
      "color-token",
      { ...page, elements: page.elements.slice(0, 2) },
      seeded(1),
    )
    expect(plan?.style).toEqual({ "background-color": "var(--destructive)" })
  })

  test("blends the text color into the surface behind it", () => {
    const plan = planMutation(
      "contrast-loss",
      { ...page, elements: page.elements.slice(0, 3) },
      seeded(1),
    )
    // 80% of the surface (10) and 20% of the text color (250).
    expect(plan?.style).toEqual({ color: "rgb(58, 58, 58)" })
  })

  test("turns a dark surface into the light theme", () => {
    const plan = planMutation("dark-surface", page, seeded(1))
    expect(plan?.style).toEqual({
      "--background": "oklch(1 0 0)",
      "--card": "oklch(1 0 0)",
      "color-scheme": "light",
      "background-color": "var(--card)",
      color: "var(--card-foreground)",
    })
  })

  test("focuses the target before it removes its focus ring", () => {
    expect(planMutation("focus-ring", page, seeded(1))).toEqual({
      kind: "focus-ring",
      target: 4,
      focus: true,
      repeatText: 0,
      style: { outline: "none", "box-shadow": "none" },
    })
  })

  test("returns null when no element can show the class", () => {
    const bare = { ...page, elements: page.elements.slice(0, 1) }
    for (const kind of regressionClasses)
      expect(planMutation(kind, bare, seeded(1))).toBeNull()
  })

  test("never targets an element that is not fully on the screen", () => {
    const off = {
      ...page,
      elements: [
        page.elements[0]!,
        element({
          box: { x: 1400, y: 10, width: 120, height: 30 },
          tag: "button",
          focusable: true,
          focusRing: true,
        }),
      ],
    }
    expect(planMutation("focus-ring", off, seeded(1))).toBeNull()
  })

  test("changes the whole story by less than a pixel for a noise case", () => {
    expect(planMutation("subpixel-shift", page, seeded(1))).toEqual({
      kind: "subpixel-shift",
      target: 0,
      focus: false,
      repeatText: 0,
      style: { transform: "translate(0.5px, 0)" },
    })
    expect(planMutation("antialiasing", page, seeded(1))?.style).toEqual({
      "-webkit-text-stroke": "0.2px currentColor",
    })
  })

  test("the same seed gives the same plan, another seed can differ", () => {
    const many = {
      ...page,
      elements: [
        page.elements[0]!,
        ...Array.from({ length: 30 }, (_, i) =>
          element({
            box: { x: 10, y: 10 + i * 25, width: 300, height: 20 },
            text: true,
            textWidth: 200,
          }),
        ),
      ],
    }
    const pick = (seed: number) =>
      planMutation("truncated-text", many, seeded(seed))?.target
    expect(pick(7)).toBe(pick(7))
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(pick)).size).toBeGreaterThan(1)
  })
})

describe("knownRegion", () => {
  const viewport = { width: 1440, height: 900 }

  test("is the union of the boxes of the target before and after", () => {
    expect(
      knownRegion(
        [
          { x: 100, y: 100, width: 200, height: 40 },
          { x: 100, y: 100, width: 320, height: 24 },
        ],
        viewport,
      ),
    ).toEqual({ x: 98, y: 98, width: 324, height: 44 })
  })

  test("rounds out to whole pixels and stays on the screen", () => {
    expect(
      knownRegion([{ x: 1.4, y: -3, width: 1440.2, height: 10.5 }], viewport),
    ).toEqual({ x: 0, y: 0, width: 1440, height: 10 })
  })

  test("is null when no box is on the screen", () => {
    expect(
      knownRegion([{ x: 2000, y: 10, width: 20, height: 20 }], viewport),
    ).toBeNull()
  })
})
