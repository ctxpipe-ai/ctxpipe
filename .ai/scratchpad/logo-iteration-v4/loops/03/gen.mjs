import {
  CELL,
  lockup,
  barsMark,
  barsMark16,
  plateMark,
  plateMark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../echo.mjs"
import { family } from "../../family.mjs"

const root = new URL(".", import.meta.url).pathname
const C = CELL

// Basis: L2B double hit (solid 1c + 2c SE).
// Four architectures that still carry two solid echo hits.

// A split axis — east hit + south hit (two-direction register)
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C * 2, dy: 0, fill: TEAL },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#1A6B66" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C * 2, dy: 0, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#99F6E4" },
      { dx: C * 2, dy: 0, fill: "#14B8A6" },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 7, stepY: 0, barW: 8 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 7, stepY: 0, barW: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// B pipe afterimage — keep double letters; cursor is a 3-bar trail
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#2A9B94" },
      { dx: C, dy: C, fill: TEAL },
    ],
    pipeEchoes: [
      { dx: -C * 4, dy: 0, fill: TEAL, opacity: 0.28 },
      { dx: -C * 2.5, dy: 0, fill: TEAL, opacity: 0.5 },
      { dx: -C * 1.2, dy: 0, fill: TEAL, opacity: 0.75 },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#99F6E4" },
      { dx: C, dy: C, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [
      { dx: -C * 4, dy: 0, fill: TEAL_LIGHT, opacity: 0.25 },
      { dx: -C * 2.5, dy: 0, fill: TEAL_LIGHT, opacity: 0.45 },
      { dx: -C * 1.2, dy: 0, fill: TEAL_LIGHT, opacity: 0.7 },
    ],
  }),
  barsMark({
    fills: [TEAL, TEAL, TEAL, INK_DARK],
    opacities: [0.3, 0.5, 0.75, 1],
    stepX: 5,
    stepY: 0,
    barW: 8,
  }),
  barsMark({
    fills: ["#A1A1AA", "#A1A1AA", "#A1A1AA", INK_DARK],
    opacities: [0.3, 0.5, 0.75, 1],
    stepX: 5,
    stepY: 0,
    barW: 8,
  }),
  barsMark16({ fills: [TEAL, TEAL, INK_DARK], opacities: [0.4, 0.7, 1], stepX: 2, barW: 3 }),
)

// C plate — double hit sits on a zinc card
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    field: { fill: "#18181B", x: -8, y: 8, w: 214, h: 96 },
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#2A9B94" },
      { dx: C, dy: C, fill: TEAL },
    ],
    pipeEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#1A6B66" },
      { dx: C, dy: C, fill: "#2A9B94" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    field: { fill: "#E4E4E7", x: -8, y: 8, w: 214, h: 96 },
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#99F6E4" },
      { dx: C, dy: C, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#CCFBF1" },
      { dx: C, dy: C, fill: "#5EEAD4" },
    ],
  }),
  plateMark({ fill: "#18181B", ghost: TEAL, cut: INK_DARK }),
  plateMark({ fill: INK_DARK, ghost: "#A1A1AA", cut: "#09090B" }),
  plateMark16({ fill: "#18181B", ghost: TEAL, cut: INK_DARK }),
)

// D invert double — teal letters, ink ghosts, teal pipe
family(
  root,
  "d",
  lockup({
    ink: TEAL,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#27272A" },
      { dx: C, dy: C, fill: INK_DARK },
    ],
    pipeEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#27272A" },
      { dx: C, dy: C, fill: INK_DARK },
    ],
  }),
  lockup({
    ink: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#D4D4D8" },
      { dx: C, dy: C, fill: INK_LIGHT },
    ],
    pipeEchoes: [
      { dx: C * 2, dy: C * 2, fill: "#D4D4D8" },
      { dx: C, dy: C, fill: INK_LIGHT },
    ],
  }),
  barsMark({ fills: [INK_DARK, TEAL], stepX: 6, stepY: 6 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 6 }),
  barsMark16({ fills: [INK_DARK, TEAL] }),
)
