import { heritageLockup } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"
import { wordmarkSvg, pipeMarkSvg, hintedPipe16 } from "../../../logo-iteration-v2/outline.mjs"

const root = new URL(".", import.meta.url).pathname
const PIXEL = "apps/ui/public/fonts/GeistPixel-Square.woff2"
const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )

const chamfer = (ink, echo, echoFill, block, cut = 8) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M176 28h${28 - cut}l${cut} ${cut}v${56 - cut}h-28z"/>
`

write(root + "a-chamfer-echo-dark.svg", wrap(212, 112, chamfer("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "a-chamfer-echo-light.svg", wrap(212, 112, chamfer("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "a-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

write(root + "b-deep-cut-dark.svg", wrap(212, 112, chamfer("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", 16)))
write(root + "b-deep-cut-light.svg", wrap(212, 112, chamfer("#09090B", 4.864, "#0F766E", "#0F766E", 16)))
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h16l16 16v16H16z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h16l16 16v16H16z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h6l4 4v6H3z"/>`))

write(root + "c-type-dark.svg", wordmarkSvg(PIXEL, { ink: "#F4F4F5", pipe: "#40E0D0", pipeScaleX: 2.4, pipeKern: -0.4 }))
write(root + "c-type-light.svg", wordmarkSvg(PIXEL, { ink: "#09090B", pipe: "#0F766E", pipeScaleX: 2.2, pipeKern: -0.4 }))
write(root + "c-mark.svg", pipeMarkSvg(PIXEL, { fill: "#40E0D0", barScaleX: 2.2 }))
write(root + "c-mark-mono.svg", pipeMarkSvg(PIXEL, { fill: "#F4F4F5", barScaleX: 2.2 }))
write(root + "c-mark16.svg", hintedPipe16({ fill: "#40E0D0", w: 5, h: 14 }))

const neg = (ink, echo, echoFill, plate) => `
  ${word(ink, echo, echoFill)}
  <path fill="${plate}" fill-rule="evenodd" d="M172 24h36v64H172V24zm8 8h20l8 8v40h-28V32z"/>
`
write(root + "d-negative-dark.svg", wrap(216, 112, neg("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "d-negative-light.svg", wrap(216, 112, neg("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "d-mark.svg", wrap(64, 64, `<path fill="#40E0D0" fill-rule="evenodd" d="M8 8h48v48H8V8zm8 8h24l8 8v24H16V16z"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" fill-rule="evenodd" d="M8 8h48v48H8V8zm8 8h24l8 8v24H16V16z"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" fill-rule="evenodd" d="M1 1h14v14H1V1zm2 2h8l2 2v8H3V3z"/>`))
