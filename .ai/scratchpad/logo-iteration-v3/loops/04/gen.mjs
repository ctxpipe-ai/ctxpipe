import { heritageLockup, heritageMark16, LETTERS } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname
const cOnly = LETTERS.split("ZM")[0] + "Z"

const block = (ink, echo, echoFill, cursor, { x = 176, w = 28, y = 28, h = 56 } = {}) => `
  ${heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(/<\/?svg[^>]*>/g, "")}
  <rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${cursor}"/>
`

write(root + "a-block-echo-dark.svg", wrap(212, 112, block("#40E0D0", 4.864, "#F4F4F5", "#F4F4F5")))
write(root + "a-block-echo-light.svg", wrap(212, 112, block("#0F766E", 4.864, "#09090B", "#09090B")))
write(root + "a-mark.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#F4F4F5"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#F4F4F5"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<rect x="3" y="3" width="10" height="10" fill="#40E0D0"/>`))

write(root + "b-teal-block-dark.svg", wrap(212, 112, block("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "b-teal-block-light.svg", wrap(212, 112, block("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "b-mark.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#40E0D0"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#F4F4F5"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<rect x="3" y="3" width="10" height="10" fill="#40E0D0"/>`))

const notched = (ink, echo, echoFill, cursor) => `
  ${heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(/<\/?svg[^>]*>/g, "")}
  <path fill="${cursor}" d="M176 28h28v56h-28V28zm8 36h12v12h-12z"/>
`
write(root + "c-notch-dark.svg", wrap(212, 112, notched("#40E0D0", 4.864, "#F4F4F5", "#F4F4F5")))
write(root + "c-notch-light.svg", wrap(212, 112, notched("#0F766E", 4.864, "#09090B", "#09090B")))
write(root + "c-mark.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h32v32H16V16zm8 20h16v8H24z"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h32v32H16V16zm8 20h16v8H24z"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h10v10H3V3zm2 6h6v2H5z"/>`))

const lock = (ink, echo, echoFill) => `
  <g transform="translate(4,16) scale(0.7)" fill="${ink}"><path d="${cOnly}"/></g>
  <rect x="52" y="12" width="8" height="80" fill="#F4F4F5"/>
  <g transform="translate(72,8)">${heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(/<\/?svg[^>]*>/g, "")}</g>
`
write(root + "d-mark-word-dark.svg", wrap(280, 112, lock("#40E0D0", 4.864, "#F4F4F5").replace("#F4F4F5", "#F4F4F5")))
write(root + "d-mark-word-light.svg", wrap(280, 112, lock("#0F766E", 4.864, "#09090B").replace("#F4F4F5", "#09090B")))
write(root + "d-mark.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.55)" fill="#40E0D0"><path d="${cOnly}"/></g><rect x="48" y="8" width="8" height="48" fill="#F4F4F5"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.55)" fill="#F4F4F5"><path d="${cOnly}"/></g><rect x="48" y="8" width="8" height="48" fill="#F4F4F5"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<rect x="2" y="3" width="8" height="10" fill="none" stroke="#40E0D0" stroke-width="2"/><rect x="12" y="2" width="3" height="12" fill="#F4F4F5"/>`))
void heritageMark16
