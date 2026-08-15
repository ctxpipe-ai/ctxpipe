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

// Basis: L1A solid 1-cell SE + pipe echo.
// Four new directions of that register.

// A south drop — Y only
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: 0, dy: C * 2, fill: TEAL }],
    pipeEchoes: [{ dx: 0, dy: C * 2, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: 0, dy: C * 2, fill: TEAL_LIGHT }],
    pipeEchoes: [{ dx: 0, dy: C * 2, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 0, stepY: 8 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 0, stepY: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 0 }),
)

// B double hit — 1 cell + 2 cell, both solid
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
      { dx: C * 2, dy: C * 2, fill: "#1A6B66" },
      { dx: C, dy: C, fill: "#2A9B94" },
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
      { dx: C * 2, dy: C * 2, fill: "#CCFBF1" },
      { dx: C, dy: C, fill: "#5EEAD4" },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 5, stepY: 5, barW: 8 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 5, stepY: 5, barW: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK], stepX: 3 }),
)

// C NE register — up-right (rising cursor)
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [{ dx: C, dy: -C, fill: TEAL }],
    pipeEchoes: [{ dx: C, dy: -C, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [{ dx: C, dy: -C, fill: TEAL_LIGHT }],
    pipeEchoes: [{ dx: C, dy: -C, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [INK_DARK, TEAL], stepX: 6, stepY: -6 }),
  barsMark({ fills: [INK_DARK, "#A1A1AA"], stepX: 6, stepY: -6 }),
  barsMark16({ fills: [INK_DARK, TEAL] }),
)

// D fat pipe register — same letter echo, oversized echoed cursor
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeW: 22,
    pipeX: 176,
    letterEchoes: [{ dx: C, dy: C, fill: TEAL }],
    pipeEchoes: [{ dx: C, dy: C, fill: "#2A9B94" }],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    pipeW: 22,
    pipeX: 176,
    letterEchoes: [{ dx: C, dy: C, fill: TEAL_LIGHT }],
    pipeEchoes: [{ dx: C, dy: C, fill: "#99F6E4" }],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 8, stepY: 6, barW: 16 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 8, stepY: 6, barW: 16 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 6, stepX: 3 }),
)
