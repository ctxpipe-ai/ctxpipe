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

const fat = { pipeW: 20, pipeX: 178 }

// Basis: L8B three + fat.

// A color — teal trail, ink letters, fat teal pipe
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#1A6B66" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    ...fat,
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

// B mono — one ink, steps as gray
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: INK_DARK,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#3F3F46" },
      { dx: C * 2, dy: 0, fill: "#71717A" },
      { dx: C, dy: 0, fill: "#A1A1AA" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: INK_LIGHT,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#E4E4E7" },
      { dx: C * 2, dy: 0, fill: "#A1A1AA" },
      { dx: C, dy: 0, fill: "#71717A" },
    ],
  }),
  barsMark({ fills: ["#3F3F46", "#71717A", INK_DARK], stepX: 5, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#3F3F46", "#71717A", INK_DARK], stepX: 5, stepY: 0, barW: 12 }),
  barsMark16({ fills: [INK_DARK, "#71717A"], barW: 5, stepX: 3 }),
)

// C invert — teal letters, ink trail, ink pipe
family(
  root,
  "c",
  lockup({
    ink: TEAL,
    pipe: INK_DARK,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#27272A" },
      { dx: C * 2, dy: 0, fill: "#3F3F46" },
      { dx: C, dy: 0, fill: INK_DARK },
    ],
  }),
  lockup({
    ink: TEAL_LIGHT,
    pipe: INK_LIGHT,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#E4E4E7" },
      { dx: C * 2, dy: 0, fill: "#A1A1AA" },
      { dx: C, dy: 0, fill: INK_LIGHT },
    ],
  }),
  barsMark({ fills: ["#27272A", INK_DARK, TEAL], stepX: 5, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK, TEAL_LIGHT], stepX: 5, stepY: 0, barW: 12 }),
  barsMark16({ fills: [INK_DARK, TEAL], barW: 5, stepX: 3 }),
)

// D night — darker teal trail, same fat pipe
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#115E59" },
      { dx: C * 2, dy: 0, fill: "#0F766E" },
      { dx: C, dy: 0, fill: "#14B8A6" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: "#115E59",
    ...fat,
    letterEchoes: [
      { dx: C * 3, dy: 0, fill: "#99F6E4" },
      { dx: C * 2, dy: 0, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: "#0F766E" },
    ],
  }),
  barsMark({ fills: ["#115E59", "#0F766E", TEAL], stepX: 5, stepY: 0, barW: 12 }),
  barsMark({ fills: ["#115E59", "#0F766E", INK_DARK], stepX: 5, stepY: 0, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5, stepX: 3 }),
)
