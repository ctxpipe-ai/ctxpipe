import { decode, encode } from "@blazediff/codec-png-native"
import { describe, expect, test } from "vitest"

import { duplicateBaselines } from "./duplicates.ts"
import { screenshot } from "./fixtures.ts"

const card = screenshot(80, 60, [
  { box: { x: 10, y: 10, width: 40, height: 20 }, color: [37, 99, 235] },
])
const otherCard = screenshot(80, 60, [
  { box: { x: 10, y: 10, width: 40, height: 21 }, color: [37, 99, 235] },
])

describe("duplicateBaselines", () => {
  test("two stories with the same pixels are one group, and other stories are not in it", () => {
    expect(
      duplicateBaselines([
        {
          path: "b/Card.Connected.desktop.png",
          story: "Card#Connected",
          png: card,
        },
        {
          path: "a/Row.Connected.desktop.png",
          story: "Row#Connected",
          png: card,
        },
        {
          path: "a/Card.Taller.desktop.png",
          story: "Card#Taller",
          png: otherCard,
        },
      ]),
    ).toEqual([["a/Row.Connected.desktop.png", "b/Card.Connected.desktop.png"]])
  })

  test("the same pixels in another PNG encoding are a duplicate", () => {
    const recompressed = encode(decode(card), {
      compression: 1,
      filter: "paeth",
    })
    expect(Buffer.from(recompressed).equals(Buffer.from(card))).toBe(false)
    expect(
      duplicateBaselines([
        { path: "Card.A.png", story: "Card#A", png: card },
        { path: "Card.B.png", story: "Card#B", png: recompressed },
      ]),
    ).toHaveLength(1)
  })

  test("the same color at another size is not a duplicate", () => {
    const blank = (width: number, height: number) =>
      screenshot(width, height, [])
    expect(
      duplicateBaselines([
        { path: "Card.Wide.png", story: "Card#Wide", png: blank(60, 20) },
        { path: "Card.Tall.png", story: "Card#Tall", png: blank(20, 60) },
      ]),
    ).toEqual([])
  })

  test("a story with a duplicate reason may share the pixels of one story", () => {
    const allowed = {
      path: "Card.Hidden.png",
      story: "Card#Hidden",
      png: card,
      duplicate: "The hidden state looks the same on purpose.",
    }
    expect(
      duplicateBaselines([
        { path: "Card.Shown.png", story: "Card#Shown", png: card },
        allowed,
      ]),
    ).toEqual([])
    // A third story with no reason makes the group fail again.
    expect(
      duplicateBaselines([
        { path: "Card.Shown.png", story: "Card#Shown", png: card },
        allowed,
        { path: "Card.Copy.png", story: "Card#Copy", png: card },
      ]),
    ).toEqual([["Card.Copy.png", "Card.Hidden.png", "Card.Shown.png"]])
  })

  test("two baselines of one story are not a duplicate", () => {
    expect(
      duplicateBaselines([
        { path: "Card.Open.desktop.png", story: "Card#Open", png: card },
        { path: "Card.Open@menu.desktop.png", story: "Card#Open", png: card },
      ]),
    ).toEqual([])
  })
})
