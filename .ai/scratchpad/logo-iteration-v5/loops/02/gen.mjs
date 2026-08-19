import {
  terminal,
  markWindow,
  mark16,
  TEAL,
  TEAL_LIGHT,
  INK_DARK,
  INK_LIGHT,
} from "../../term.mjs"
import { family } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const CELL = 4.864

const marks = (pipe) => [
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe, title: true }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: INK_DARK, title: true }),
  mark16({ frame: pipe, pipe, screen: "#18181B" }),
]

// A thin chrome — reviewer craft
family(
  root,
  "a",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#18181B",
    pipe: TEAL,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
  }),
  ...marks(TEAL),
)

// B echo glass — pass 4 echo lives inside the terminal
family(
  root,
  "b",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#18181B",
    pipe: TEAL,
    titleBar: 10,
    bezel: 2,
    pad: 14,
    scale: 0.56,
    echoes: [
      { dx: CELL * 3, dy: 0, fill: "#1A6B66" },
      { dx: CELL * 2, dy: 0, fill: "#2A9B94" },
      { dx: CELL, dy: 0, fill: TEAL },
    ],
    pipeW: 18,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 10,
    bezel: 2,
    pad: 14,
    scale: 0.56,
    echoes: [
      { dx: CELL * 3, dy: 0, fill: "#CCFBF1" },
      { dx: CELL * 2, dy: 0, fill: "#5EEAD4" },
      { dx: CELL, dy: 0, fill: TEAL_LIGHT },
    ],
    pipeW: 18,
  }),
  ...marks(TEAL),
)

// C title tick — teal lives on the chrome strip; | stays
family(
  root,
  "c",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#18181B",
    pipe: TEAL,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
    tab: true,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
    tab: true,
  }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: TEAL, title: true }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: INK_DARK, title: true }),
  mark16({ frame: TEAL, pipe: TEAL, screen: "#18181B" }),
)

// D knockout glass — teal screen, ctx| cut out, title bar stays
family(
  root,
  "d",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: TEAL,
    pipe: TEAL,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
    screenCut: true,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: TEAL_LIGHT,
    pipe: TEAL_LIGHT,
    titleBar: 10,
    bezel: 2,
    pad: 12,
    scale: 0.6,
    screenCut: true,
  }),
  markWindow({ frame: INK_DARK, screen: TEAL, pipe: INK_DARK, title: true }),
  markWindow({ frame: INK_DARK, screen: INK_DARK, pipe: INK_DARK, title: true }),
  mark16({ frame: INK_DARK, pipe: TEAL, screen: TEAL }),
)
