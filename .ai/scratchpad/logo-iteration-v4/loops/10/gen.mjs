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

// Basis: L9A color (three-step east + fat pipe).

// A ref
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#1A6B66" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#CCFBF1" },
      { dx: C * 2, dy: 0, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL], stepX: 5, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA"], stepX: 5, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 3 }),
)

// B dock — trail meets the fat cursor
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 172,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#1A6B66" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 172,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#CCFBF1" },
      { dx: C * 2, dy: 0, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL], stepX: 4, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA"], stepX: 4, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 2 }),
)

// C two-step — drop the farthest hit
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 2, dy: 0, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL], stepX: 6, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#71717A", "#A1A1AA"], stepX: 6, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 3 }),
)

// D tighter + fat
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 2, dy: 0, fill: "#1A6B66" },
      { dx: C * 1.25, dy: 0, fill: "#2A9B94" },
      { dx: C * 0.6, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 20,
    pipeX: 178,
    letterEchoes: [
      { dx: C * 2, dy: 0, fill: "#CCFBF1" },
      { dx: C * 1.25, dy: 0, fill: "#5EEAD4" },
      { dx: C * 0.6, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: ["#1A6B66", "#2A9B94", TEAL], stepX: 4, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#52525B", "#71717A", "#A1A1AA"], stepX: 4, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 2 }),
)
