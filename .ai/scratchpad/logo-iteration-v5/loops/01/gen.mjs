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

// A chrome — title bar + screen filled with pixel ctx|
family(
  root,
  "a",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#18181B",
    pipe: TEAL,
    titleBar: 16,
    dots: false,
    bezel: 3,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 16,
    dots: false,
    bezel: 3,
  }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: TEAL, title: true }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: INK_DARK, title: true }),
  mark16({ frame: TEAL, pipe: TEAL, screen: "#18181B" }),
)

// B cli — no title chrome; teal prompt > then ctx|
family(
  root,
  "b",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#09090B",
    pipe: TEAL,
    titleBar: 0,
    prompt: 36,
    bezel: 4,
    pad: 12,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#F4F4F5",
    pipe: TEAL_LIGHT,
    titleBar: 0,
    prompt: 36,
    bezel: 4,
    pad: 12,
  }),
  markWindow({ frame: INK_DARK, screen: "#09090B", pipe: TEAL, title: false, chevron: true }),
  markWindow({ frame: INK_DARK, screen: "#09090B", pipe: INK_DARK, title: false, chevron: true }),
  mark16({ frame: TEAL, pipe: TEAL, screen: "#09090B", chevron: true }),
)

// C bezel — thick glass, ctx| on the screen, no title
family(
  root,
  "c",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#0C0C0E",
    pipe: TEAL,
    titleBar: 0,
    bezel: 10,
    pad: 14,
    scale: 0.55,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 0,
    bezel: 10,
    pad: 14,
    scale: 0.55,
  }),
  markWindow({ frame: INK_DARK, screen: "#0C0C0E", pipe: TEAL, title: false, bezel: 8 }),
  markWindow({ frame: INK_DARK, screen: "#0C0C0E", pipe: INK_DARK, title: false, bezel: 8 }),
  mark16({ frame: TEAL, pipe: TEAL, screen: "#0C0C0E" }),
)

// D pipe-frame — right edge is the fat teal pipe; ctx| inside
family(
  root,
  "d",
  terminal({
    ink: INK_DARK,
    frame: INK_DARK,
    screen: "#18181B",
    pipe: TEAL,
    titleBar: 12,
    pipeFrame: true,
    pipeW: 18,
    bezel: 3,
  }),
  terminal({
    ink: INK_LIGHT,
    frame: INK_LIGHT,
    screen: "#E4E4E7",
    pipe: TEAL_LIGHT,
    titleBar: 12,
    pipeFrame: true,
    pipeW: 18,
    bezel: 3,
  }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: TEAL, title: true, fatRight: true, block: false }),
  markWindow({ frame: INK_DARK, screen: "#18181B", pipe: INK_DARK, title: true, fatRight: true, block: false }),
  mark16({ frame: INK_DARK, pipe: TEAL, screen: "#18181B", fatRight: true }),
)
