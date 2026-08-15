import { heritageLockup, heritageMark, heritageMark16 } from "../../pixel.mjs"
import { write, wrap } from "../../write.mjs"

const root = new URL(".", import.meta.url).pathname

write(
  root + "a-echo-fat-dark.svg",
  heritageLockup({
    ink: "#F4F4F5",
    pipe: "#40E0D0",
    pipeW: 22,
    pipeX: 176,
    echo: 4.864,
    echoFill: "#40E0D0",
  }),
)
write(
  root + "a-echo-fat-light.svg",
  heritageLockup({
    ink: "#09090B",
    pipe: "#0F766E",
    pipeW: 22,
    pipeX: 176,
    echo: 4.864,
    echoFill: "#0F766E",
  }),
)
write(root + "a-mark.svg", heritageMark({ fill: "#40E0D0", w: 16 }))
write(root + "a-mark-mono.svg", heritageMark({ fill: "#F4F4F5", w: 16 }))
write(root + "a-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 5 }))

write(
  root + "b-invert-dark.svg",
  heritageLockup({
    ink: "#40E0D0",
    pipe: "#F4F4F5",
    echo: 4.864,
    echoFill: "#F4F4F5",
  }),
)
write(
  root + "b-invert-light.svg",
  heritageLockup({
    ink: "#0F766E",
    pipe: "#09090B",
    echo: 4.864,
    echoFill: "#09090B",
  }),
)
write(
  root + "b-mark.svg",
  wrap(
    64,
    64,
    `<rect x="20" y="8" width="12" height="44" fill="#F4F4F5"/><rect x="26" y="12" width="12" height="44" fill="#40E0D0"/>`,
  ),
)
write(
  root + "b-mark-mono.svg",
  wrap(
    64,
    64,
    `<rect x="20" y="8" width="12" height="44" fill="#A1A1AA"/><rect x="26" y="12" width="12" height="44" fill="#F4F4F5"/>`,
  ),
)
write(root + "b-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 5 }))

write(
  root + "c-hard-dark.svg",
  heritageLockup({
    ink: "#F4F4F5",
    pipe: "#40E0D0",
    echo: 9.728,
    echoFill: "#40E0D0",
  }),
)
write(
  root + "c-hard-light.svg",
  heritageLockup({
    ink: "#09090B",
    pipe: "#0F766E",
    echo: 9.728,
    echoFill: "#0F766E",
  }),
)
write(root + "c-mark.svg", heritageMark({ fill: "#40E0D0", w: 12 }))
write(root + "c-mark-mono.svg", heritageMark({ fill: "#F4F4F5", w: 12 }))
write(root + "c-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 4 }))

const stamp = (ink, pipe) => `
  <rect x="2" y="8" width="268" height="96" fill="none" stroke="${ink}" stroke-width="3"/>
  <g transform="translate(8,0)">${heritageLockup({ ink, pipe, echo: 4.864, echoFill: pipe }).replace(/<\/?svg[^>]*>/g, "")}</g>
`
write(root + "d-echo-stamp-dark.svg", wrap(276, 112, stamp("#F4F4F5", "#40E0D0")))
write(root + "d-echo-stamp-light.svg", wrap(276, 112, stamp("#09090B", "#0F766E")))
write(
  root + "d-mark.svg",
  wrap(
    64,
    64,
    `<rect x="6" y="6" width="52" height="52" fill="none" stroke="#F4F4F5" stroke-width="3"/><rect x="24" y="12" width="8" height="36" fill="#40E0D0"/><rect x="28" y="16" width="8" height="36" fill="#F4F4F5"/>`,
  ),
)
write(
  root + "d-mark-mono.svg",
  wrap(
    64,
    64,
    `<rect x="6" y="6" width="52" height="52" fill="none" stroke="#F4F4F5" stroke-width="3"/><rect x="24" y="12" width="8" height="36" fill="#A1A1AA"/><rect x="28" y="16" width="8" height="36" fill="#F4F4F5"/>`,
  ),
)
write(root + "d-mark16.svg", heritageMark16({ fill: "#40E0D0", w: 4 }))
