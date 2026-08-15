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

const scanDefs = (id, fill) => `<defs>
  <pattern id="${id}" width="${C}" height="${C * 2}" patternUnits="userSpaceOnUse">
    <rect width="${C}" height="${C}" fill="${fill}"/>
  </pattern>
</defs>`

// Basis: L3A split axis (east + south).
// Four new ways to hold that dual register.

// A unequal — east 1c, south 2c
family(
  root,
  "a",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C, dy: 0, fill: TEAL },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#1A6B66" },
      { dx: C, dy: 0, fill: "#2A9B94" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C, dy: 0, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#99F6E4" },
      { dx: C, dy: 0, fill: "#14B8A6" },
    ],
  }),
  barsMark({ fills: ["#2A9B94", TEAL, INK_DARK], stepX: 6, stepY: 4, barW: 8 }),
  barsMark({ fills: ["#71717A", "#A1A1AA", INK_DARK], stepX: 6, stepY: 4, barW: 8 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// B clean pipe — split lives on letters only
family(
  root,
  "b",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C * 2, dy: 0, fill: TEAL },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C * 2, dy: 0, fill: TEAL_LIGHT },
    ],
  }),
  barsMark({ fills: [TEAL], barW: 10, stepX: 0, stepY: 0 }),
  barsMark({ fills: [INK_DARK], barW: 10, stepX: 0, stepY: 0 }),
  barsMark16({ fills: [TEAL], barW: 4, stepX: 0 }),
)

// C scan split — dual register in hatch (merch / print)
family(
  root,
  "c",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    defs: scanDefs("scanD", TEAL),
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "url(#scanD)" },
      { dx: C * 2, dy: 0, fill: "url(#scanD)" },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#2A9B94" },
      { dx: C * 2, dy: 0, fill: "#2A9B94" },
    ],
  }),
  lockup({
    ink: INK_LIGHT,
    pipe: TEAL_LIGHT,
    defs: scanDefs("scanL", TEAL_LIGHT),
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "url(#scanL)" },
      { dx: C * 2, dy: 0, fill: "url(#scanL)" },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#99F6E4" },
      { dx: C * 2, dy: 0, fill: "#99F6E4" },
    ],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 6, stepY: 6 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 6 }),
  barsMark16({ fills: [TEAL, INK_DARK] }),
)

// D split + tall pipe — dual register, heritage oversized cursor
family(
  root,
  "d",
  lockup({
    ink: INK_DARK,
    pipe: TEAL,
    pipeH: 128,
    pipeY: -8,
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
    pipeH: 128,
    pipeY: -8,
    letterEchoes: [
      { dx: 0, dy: C * 2, fill: "#5EEAD4" },
      { dx: C * 2, dy: 0, fill: TEAL_LIGHT },
    ],
    pipeEchoes: [
      { dx: 0, dy: C * 2, fill: "#99F6E4" },
      { dx: C * 2, dy: 0, fill: "#14B8A6" },
    ],
  }),
  barsMark({ fills: [TEAL, INK_DARK], stepX: 6, stepY: 6, barW: 12 }),
  barsMark({ fills: ["#A1A1AA", INK_DARK], stepX: 6, stepY: 6, barW: 12 }),
  barsMark16({ fills: [TEAL, INK_DARK], barW: 5 }),
)
