/** Terminal-object lockups. Letters are the shipped pixel `ctx` paths. */

export const LETTERS =
  "M4.86399 87.552V77.824H-1.33514e-05V48.64H4.86399V38.912H9.72799V34.048H14.592V29.184H43.776V34.048H48.64V38.912H53.504V43.776H58.368V53.504H48.64V48.64H43.776V43.776H38.912V38.912H19.456V43.776H14.592V48.64H9.72799V77.824H14.592V82.688H19.456V87.552H38.912V82.688H43.776V77.824H48.64V72.96H58.368V82.688H53.504V87.552H48.64V92.416H43.776V97.28H14.592V92.416H9.72799V87.552H4.86399ZM77.853 87.552V38.912H68.125V29.184H77.853V14.592H87.581V29.184H107.037V38.912H87.581V87.552H107.037V97.28H87.581V92.416H82.717V87.552H77.853ZM116.75 97.28V82.688H121.614V77.824H126.478V72.96H131.342V68.096H136.206V58.368H131.342V53.504H126.478V48.64H121.614V43.776H116.75V29.184H126.478V38.912H131.342V43.776H136.206V48.64H141.07V58.368H145.934V48.64H150.798V43.776H155.662V38.912H160.526V29.184H170.254V43.776H165.39V48.64H160.526V53.504H155.662V58.368H150.798V68.096H155.662V72.96H160.526V77.824H165.39V82.688H170.254V97.28H160.526V87.552H155.662V77.824H145.934V68.096H141.07V77.824H131.342V87.552H126.478V97.28H116.75Z"

export const LETTER_W = 195
export const LETTER_H = 112
export const PIPE = { x: 184.864, y: 0, w: 9.728, h: 111.872 }

export const TEAL = "#40E0D0"
export const TEAL_LIGHT = "#0F766E"
export const INK_DARK = "#F4F4F5"
export const INK_LIGHT = "#09090B"

export function letterGroup({
  x,
  y,
  scale = 0.62,
  ink,
  pipe = TEAL,
  pipeW = PIPE.w,
  echoes = [],
  prompt = 0,
}) {
  const echo = echoes
    .map((e) => {
      const op = e.opacity == null ? "" : ` opacity="${e.opacity}"`
      return `<g transform="translate(${e.dx ?? 0} ${e.dy ?? 0})" fill="${e.fill}"${op}><path d="${LETTERS}"/></g>`
    })
    .join("")
  const chev =
    prompt <= 0
      ? ""
      : `<polygon points="0,20 ${prompt},56 0,92" fill="${pipe}"/>`
  return `<g transform="translate(${x} ${y}) scale(${scale})">
  ${chev}
  <g transform="translate(${prompt} 0)">
    ${echo}
    <path fill="${ink}" d="${LETTERS}"/>
    <rect x="${PIPE.x}" y="${PIPE.y}" width="${pipeW}" height="${PIPE.h}" fill="${pipe}"/>
  </g>
</g>`
}

export function terminal({
  ink = INK_DARK,
  frame = INK_DARK,
  screen = "#09090B",
  pipe = TEAL,
  titleBar = 14,
  dots = false,
  bezel = 3,
  pad = 10,
  scale = 0.58,
  prompt = 0,
  pipeW = PIPE.w,
  echoes = [],
  letters = true,
  emptyCursor = false,
  pipeFrame = false,
  screenCut = false,
} = {}) {
  const promptGap = prompt
  const contentW = Math.max(letters ? (LETTER_W + promptGap) * scale : 120, letters ? 0 : 120)
  const contentH = letters ? LETTER_H * scale : 64
  const innerW = contentW + pad * 2
  const innerH = titleBar + contentH + pad * 2
  const pipeBar = pipeFrame ? 14 : 0
  const w = bezel * 2 + innerW + pipeBar
  const h = bezel * 2 + innerH
  const ix = bezel
  const iy = bezel

  const dotY = iy + titleBar / 2
  const dotMarkup = dots
    ? `<circle cx="${ix + 8}" cy="${dotY}" r="2.2" fill="${pipe}"/><circle cx="${ix + 16}" cy="${dotY}" r="2.2" fill="${frame}" opacity="0.45"/><circle cx="${ix + 24}" cy="${dotY}" r="2.2" fill="${frame}" opacity="0.45"/>`
    : ""

  const title = titleBar
    ? `<rect x="${ix}" y="${iy}" width="${innerW}" height="${titleBar}" fill="${frame}" opacity="0.14"/>${dotMarkup}`
    : ""

  const glassX = ix
  const glassY = iy + titleBar
  const glassW = innerW
  const glassH = innerH - titleBar

  let glass = `<rect x="${glassX}" y="${glassY}" width="${glassW}" height="${glassH}" fill="${screen}"/>`
  const lx = glassX + pad
  const ly = glassY + pad
  let content = ""
  if (letters) {
    const body = letterGroup({
      x: lx,
      y: ly,
      scale,
      ink,
      pipe,
      pipeW,
      echoes,
      prompt,
    })
    if (screenCut) {
      content = `<defs><mask id="cut"><rect x="${glassX}" y="${glassY}" width="${glassW}" height="${glassH}" fill="#fff"/>
        <g transform="translate(${lx} ${ly}) scale(${scale}) translate(${prompt} 0)"><path d="${LETTERS}" fill="#000"/><rect x="${PIPE.x}" y="${PIPE.y}" width="${pipeW}" height="${PIPE.h}" fill="#000"/></g>
      </mask></defs>
      <rect x="${glassX}" y="${glassY}" width="${glassW}" height="${glassH}" fill="${pipe}" mask="url(#cut)"/>`
      glass = ""
    } else {
      content = body
    }
  } else if (emptyCursor) {
    content = `<rect x="${lx + 8}" y="${ly + contentH * 0.15}" width="${Math.max(10, contentW * 0.08)}" height="${contentH * 0.7}" fill="${pipe}"/>`
  }

  const right = pipeFrame
    ? `<rect x="${ix + innerW}" y="${iy}" width="${pipeBar}" height="${innerH}" fill="${pipe}"/>`
    : ""

  const outer = `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${frame}" stroke-width="${Math.max(bezel, 2)}"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}" height="${h.toFixed(1)}" viewBox="0 0 ${w.toFixed(1)} ${h.toFixed(1)}" fill="none">
  ${outer}
  ${title}
  ${glass}
  ${content}
  ${right}
</svg>
`
}

export function emptyTerminal({ frame = INK_DARK, screen = "#18181B", pipe = TEAL } = {}) {
  return terminal({
    frame,
    screen,
    pipe,
    ink: INK_DARK,
    titleBar: 16,
    dots: false,
    letters: false,
    emptyCursor: true,
    scale: 0.5,
    pad: 16,
    bezel: 3,
  })
}

export function markWindow({
  size = 64,
  frame = INK_DARK,
  screen = "#09090B",
  pipe = TEAL,
  title = true,
  chevron = false,
  bezel = 4,
  fatRight = false,
  block = true,
} = {}) {
  const t = title ? 10 : 0
  const right = fatRight ? 10 : 0
  const inner = size - bezel * 2 - right
  const screenH = size - bezel * 2 - t
  const cursorW = block ? 7 : 4
  const cursorH = screenH * 0.55
  const cx = bezel + (chevron ? 22 : 10)
  const cy = bezel + t + (screenH - cursorH) / 2
  const ch = chevron
    ? `<polygon points="${bezel + 7},${bezel + t + 10} ${bezel + 18},${bezel + t + screenH / 2} ${bezel + 7},${bezel + t + screenH - 10}" fill="${pipe}"/>`
    : ""
  const bar = fatRight
    ? `<rect x="${size - bezel - right}" y="${bezel}" width="${right}" height="${size - bezel * 2}" fill="${pipe}"/>`
    : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none">
  <rect x="1.5" y="1.5" width="${size - 3}" height="${size - 3}" stroke="${frame}" stroke-width="3"/>
  ${title ? `<rect x="${bezel}" y="${bezel}" width="${inner}" height="${t}" fill="${frame}" opacity="0.2"/>` : ""}
  <rect x="${bezel}" y="${bezel + t}" width="${inner}" height="${screenH}" fill="${screen}"/>
  ${ch}
  ${block && !fatRight ? `<rect x="${cx}" y="${cy}" width="${cursorW}" height="${cursorH}" fill="${pipe}"/>` : ""}
  ${bar}
</svg>
`
}

export function mark16({
  frame = TEAL,
  pipe = TEAL,
  screen = "#09090B",
  chevron = false,
  fatRight = false,
} = {}) {
  const bar = fatRight
    ? `<rect x="12" y="2" width="3" height="12" fill="${pipe}"/>`
    : `<rect x="5" y="5" width="2" height="7" fill="${pipe}"/>`
  const ch = chevron ? `<path d="M3 5l3 3-3 3" stroke="${pipe}" stroke-width="1.4" fill="none"/>` : ""
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" shape-rendering="crispEdges">
  <rect x="1" y="1" width="14" height="14" stroke="${frame}" stroke-width="1.5"/>
  <rect x="2" y="2" width="12" height="3" fill="${frame}" opacity="0.25"/>
  <rect x="2" y="5" width="${fatRight ? 10 : 12}" height="9" fill="${screen}"/>
  ${ch}
  ${bar}
</svg>
`
}
