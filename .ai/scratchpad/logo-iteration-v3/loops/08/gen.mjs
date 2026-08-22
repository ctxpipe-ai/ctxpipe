import { heritageLockup } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )
const lock = (ink, echo, echoFill, block, { x = 174, y = 26, w = 30, h = 60, cut = 10 } = {}) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M${x} ${y}h${w - cut}l${cut} ${cut}v${h - cut}h-${w}z"/>
`

write(root + "a-tight-dark.svg", wrap(210, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", { x: 170, w: 28, cut: 8 })))
write(root + "a-tight-light.svg", wrap(210, 112, lock("#09090B", 4.864, "#0F766E", "#0F766E", { x: 170, w: 28, cut: 8 })))
write(root + "a-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(root + "b-taller-dark.svg", wrap(212, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", { y: 8, h: 96, cut: 10 })))
write(root + "b-taller-light.svg", wrap(212, 112, lock("#09090B", 4.864, "#0F766E", "#0F766E", { y: 8, h: 96, cut: 10 })))
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M20 6h16l8 8v44H20z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M20 6h16l8 8v44H20z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M5 1h6l2 2v12H5z"/>`))

write(root + "c-no-echo-dark.svg", wrap(212, 112, lock("#F4F4F5", 0, "#40E0D0", "#40E0D0")))
write(root + "c-no-echo-light.svg", wrap(212, 112, lock("#09090B", 0, "#0F766E", "#0F766E")))
write(root + "c-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(root + "d-gap-dark.svg", wrap(220, 112, lock("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", { x: 184 })))
write(root + "d-gap-light.svg", wrap(220, 112, lock("#09090B", 4.864, "#0F766E", "#0F766E", { x: 184 })))
write(root + "d-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))
