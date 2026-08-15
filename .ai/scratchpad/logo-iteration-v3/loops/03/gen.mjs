import { heritageLockup, heritageMark, heritageMark16, LETTERS } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

write(
  root + "a-invert-fat-dark.svg",
  heritageLockup({
    ink: "#40E0D0",
    pipe: "#F4F4F5",
    pipeW: 22,
    pipeX: 176,
    echo: 4.864,
    echoFill: "#F4F4F5",
  }),
)
write(
  root + "a-invert-fat-light.svg",
  heritageLockup({
    ink: "#0F766E",
    pipe: "#09090B",
    pipeW: 22,
    pipeX: 176,
    echo: 4.864,
    echoFill: "#09090B",
  }),
)
write(root + "a-mark.svg", heritageMark({ fill: "#F4F4F5", w: 16 }))
write(root + "a-mark-mono.svg", heritageMark({ fill: "#F4F4F5", w: 16 }))
write(root + "a-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 5 }))

const flag = (ink, pipe, echo, echoFill) => `
  <g transform="translate(0,8)">${heritageLockup({ ink, pipe: ink, echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(/<\/?svg[^>]*>/g, "")}</g>
  <rect x="188" y="0" width="18" height="112" fill="${pipe}"/>
`
write(root + "b-flag-dark.svg", wrap(214, 112, flag("#40E0D0", "#F4F4F5", 4.864, "#F4F4F5")))
write(root + "b-flag-light.svg", wrap(214, 112, flag("#0F766E", "#09090B", 4.864, "#09090B")))
write(root + "b-mark.svg", wrap(64, 64, `<rect x="38" y="6" width="16" height="52" fill="#F4F4F5"/><path transform="translate(-20,4) scale(0.42)" fill="#40E0D0" d="${LETTERS.split("ZM")[0]}"/>`))
write(root + "b-mark-mono.svg", wrap(64, 64, `<rect x="38" y="6" width="16" height="52" fill="#F4F4F5"/>`))
write(root + "b-mark16.svg", heritageMark16({ fill: "#F4F4F5", w: 5 }))

const cOnly = LETTERS.split("ZM")[0] + "Z"
const mono = (ink, pipe) => `
  <g transform="translate(8,8) scale(0.85)" fill="${ink}"><path d="${cOnly}"/></g>
  <rect x="58" y="4" width="10" height="100" fill="${pipe}"/>
`
write(root + "c-cpipe-dark.svg", wrap(78, 108, mono("#40E0D0", "#F4F4F5")))
write(root + "c-cpipe-light.svg", wrap(78, 108, mono("#0F766E", "#09090B")))
write(root + "c-mark.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.55)" fill="#40E0D0"><path d="${cOnly}"/></g><rect x="48" y="8" width="8" height="48" fill="#F4F4F5"/>`))
write(root + "c-mark-mono.svg", wrap(64, 64, `<g transform="translate(2,6) scale(0.55)" fill="#F4F4F5"><path d="${cOnly}"/></g><rect x="48" y="8" width="8" height="48" fill="#F4F4F5"/>`))
write(root + "c-mark16.svg", wrap(16, 16, `<rect x="2" y="3" width="8" height="10" fill="none" stroke="#40E0D0" stroke-width="2"/><rect x="12" y="2" width="3" height="12" fill="#F4F4F5"/>`))

const block = (ink, echo, echoFill, cursor) => `
  ${heritageLockup({ ink, pipe: "none", echo, echoFill, pipeW: 0.01, pipeX: 400 }).replace(/<\/?svg[^>]*>/g, "")}
  <rect x="176" y="28" width="28" height="56" fill="${cursor}"/>
`
write(root + "d-block-dark.svg", wrap(212, 112, block("#40E0D0", 4.864, "#F4F4F5", "#F4F4F5")))
write(root + "d-block-light.svg", wrap(212, 112, block("#0F766E", 4.864, "#09090B", "#09090B")))
write(root + "d-mark.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#40E0D0"/>`))
write(root + "d-mark-mono.svg", wrap(64, 64, `<rect x="16" y="16" width="32" height="32" fill="#F4F4F5"/>`))
write(root + "d-mark16.svg", wrap(16, 16, `<rect x="3" y="3" width="10" height="10" fill="#40E0D0"/>`))
