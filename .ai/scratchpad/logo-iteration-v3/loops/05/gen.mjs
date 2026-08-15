import { heritageLockup, LETTERS } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

const word = (ink, echo, echoFill) =>
  heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(
    /<\/?svg[^>]*>/g,
    "",
  )

write(
  root + "a-echo-block-dark.svg",
  wrap(212, 112, `${word("#F4F4F5", 4.864, "#40E0D0")}<rect x="176" y="28" width="28" height="56" fill="#40E0D0"/>`),
)
write(
  root + "a-echo-block-light.svg",
  wrap(212, 112, `${word("#09090B", 4.864, "#0F766E")}<rect x="176" y="28" width="28" height="56" fill="#0F766E"/>`),
)
write(root + "a-mark.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#40E0D0"/>`))
write(root + "a-mark-mono.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#F4F4F5"/>`))
write(root + "a-mark16.svg", wrap(16, 16, `<rect x="3" y="3" width="10" height="10" fill="#40E0D0"/>`))

const chamfer = (ink, echo, echoFill, block) => `
  ${word(ink, echo, echoFill)}
  <path fill="${block}" d="M176 28h20l8 8v48h-28z"/>
`
write(root + "b-chamfer-dark.svg", wrap(212, 112, chamfer("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "b-chamfer-light.svg", wrap(212, 112, chamfer("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "b-mark.svg", wrap(64, 64, `<path fill="#40E0D0" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<path fill="#F4F4F5" d="M16 16h24l8 8v24H16z"/>`))
write(root + "b-mark16.svg", wrap(16, 16, `<path fill="#40E0D0" d="M3 3h8l2 2v8H3z"/>`))

const plate = (ink, echo, echoFill, block, plateStroke) => `
  <rect x="2" y="16" width="230" height="80" fill="none" stroke="${plateStroke}" stroke-width="2"/>
  <g transform="translate(8,-4)">${word(ink, echo, echoFill)}</g>
  <rect x="188" y="32" width="24" height="48" fill="${block}"/>
`
write(root + "c-plate-dark.svg", wrap(238, 112, plate("#F4F4F5", 4.864, "#40E0D0", "#40E0D0", "#3f3f46")))
write(root + "c-plate-light.svg", wrap(238, 112, plate("#09090B", 4.864, "#0F766E", "#0F766E", "#a1a1aa")))
write(root + "c-mark.svg", wrap(64, 64, `<rect x="8" y="8" width="48" height="48" fill="none" stroke="#3f3f46" stroke-width="3"/><rect x="20" y="20" width="24" height="24" fill="#40E0D0"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<rect x="8" y="8" width="48" height="48" fill="none" stroke="#F4F4F5" stroke-width="3"/><rect x="20" y="20" width="24" height="24" fill="#F4F4F5"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<rect x="1" y="1" width="14" height="14" fill="none" stroke="#40E0D0" stroke-width="2"/><rect x="5" y="5" width="6" height="6" fill="#40E0D0"/>`))

const fleet = (ink, echo, echoFill, block) => `
  ${word(ink, echo, echoFill)}
  <rect x="176" y="52" width="10" height="32" fill="${block}"/>
  <rect x="190" y="36" width="10" height="48" fill="${block}"/>
  <rect x="204" y="20" width="10" height="64" fill="${block}"/>
`
write(root + "d-fleet-dark.svg", wrap(222, 112, fleet("#F4F4F5", 4.864, "#40E0D0", "#40E0D0")))
write(root + "d-fleet-light.svg", wrap(222, 112, fleet("#09090B", 4.864, "#0F766E", "#0F766E")))
write(root + "d-mark.svg", wrap(64, 64, `<rect x="14" y="32" width="8" height="20" fill="#40E0D0"/><rect x="28" y="22" width="8" height="30" fill="#40E0D0"/><rect x="42" y="12" width="8" height="40" fill="#40E0D0"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<rect x="14" y="32" width="8" height="20" fill="#F4F4F5"/><rect x="28" y="22" width="8" height="30" fill="#F4F4F5"/><rect x="42" y="12" width="8" height="40" fill="#F4F4F5"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<rect x="2" y="8" width="3" height="6" fill="#40E0D0"/><rect x="6" y="5" width="3" height="9" fill="#40E0D0"/><rect x="10" y="2" width="3" height="12" fill="#40E0D0"/>`))
void LETTERS
