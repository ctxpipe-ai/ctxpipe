import {
  CELL,
  lockup,
  barsMark,
  barsMark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../echo.mjs"
import { family } from "../../family.mjs"

const root = new URL(".", import.meta.url).pathname
const C = CELL

// Basis: L6C stepped east (1.5c + 3c).

// A three step
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#1A6B66" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#CCFBF1" },
      { dx: C * 2, dy: 0, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL, INK_DARK], stepX: 5, stepY: 0, barW: 7 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA", INK_DARK], stepX: 5, stepY: 0, barW: 7 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 3 }),
)

// B step + south tick
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#2A9B94" },
      { dx: C * 1.5, dy: 0, fill: TEAL },
      { dx: 0, dy: C, fill: "#2A9B94" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#99F6E4" },
      { dx: C * 1.5, dy: 0, fill: TEAL_LIGHT },
      { dx: 0, dy: C, fill: "#5EEAD4" },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 6, stepY: 3, barW: 8 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 6, stepY: 3, barW: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// C step + fat pipe
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#2A9B94" },
      { dx: C * 1.5, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#99F6E4" },
      { dx: C * 1.5, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 8, stepY: 0, barW: 14 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 8, stepY: 0, barW: 14 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 6, stepX: 3 }),
)

// D teal word, ink steps, teal pipe
family(
  root,
  "d",
  lockup({
    ink: TEAL,
    pipe: INK_DARK,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#27272A" },
      { dx: C * 1.5, dy: 0, fill: INK_DARK },
    ],
  }),
  lockup({
    ink: TEAL_LIGHT,
    pipe: INK_LIGHT,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#D4D4D8" },
      { dx: C * 1.5, dy: 0, fill: INK_LIGHT },
    ],
  }),
  barsMark({ fills: [INK_DARK, TEAL], stepX: 8, stepY: 0 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 8, stepY: 0 }),
  barsMark16({ fills: [INK_DARK, TEAL] }),
)
