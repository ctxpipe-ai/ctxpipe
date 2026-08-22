#!/usr/bin/env node
import { wordmarkSvg, pipeMarkSvg, hintedPipe16, write } from "./outline.mjs"

export const PIXEL = "apps/ui/public/fonts/GeistPixel-Square.woff2"
export const GEIST = "/tmp/geist-fonts/Geist-Medium.woff2"
export const MONO = "/tmp/geist-fonts/GeistMono-Medium.woff2"

export function family(dir, fontPath, opts = {}) {
  const darkInk = opts.inkDark ?? "#F4F4F5"
  const lightInk = opts.inkLight ?? "#09090B"
  const darkPipe = opts.pipeDark ?? "#40E0D0"
  const lightPipe = opts.pipeLight ?? "#0F766E"
  const word = {
    size: opts.size ?? 36,
    tracking: opts.tracking ?? 0,
    pipeScaleX: opts.pipeScaleX ?? 1,
    pipeKern: opts.pipeKern ?? 0,
    pipeLift: opts.pipeLift ?? 0,
  }
  write(`${dir}/lockup-dark.svg`, wordmarkSvg(fontPath, { ...word, ink: darkInk, pipe: darkPipe }))
  write(
    `${dir}/lockup-light.svg`,
    wordmarkSvg(fontPath, {
      ...word,
      ink: lightInk,
      pipe: lightPipe,
      pipeScaleX: opts.pipeScaleXLight ?? word.pipeScaleX,
    }),
  )
  write(`${dir}/wordmark-dark.svg`, wordmarkSvg(fontPath, { ...word, ink: darkInk, pipe: darkInk }))
  write(`${dir}/mark-64.svg`, pipeMarkSvg(fontPath, { fill: darkPipe, barScaleX: opts.pipeScaleX ?? 1 }))
  write(`${dir}/mark-64-light.svg`, pipeMarkSvg(fontPath, { fill: lightPipe, barScaleX: opts.pipeScaleX ?? 1 }))
  write(`${dir}/mark-64-mono.svg`, pipeMarkSvg(fontPath, { fill: darkInk, barScaleX: opts.pipeScaleX ?? 1 }))
  write(`${dir}/mark-16.svg`, hintedPipe16({ fill: darkPipe, w: opts.hintW ?? 4, h: opts.hintH ?? 14 }))
  write(`${dir}/mark-16-mono.svg`, hintedPipe16({ fill: darkInk, w: opts.hintW ?? 4, h: opts.hintH ?? 14 }))
}
