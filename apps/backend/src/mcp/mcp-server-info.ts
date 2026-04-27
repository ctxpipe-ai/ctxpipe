import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Implementation } from "@modelcontextprotocol/sdk/types.js"

const moduleDir = dirname(fileURLToPath(import.meta.url))

function resolveBrandLogoPath(): string {
  return join(moduleDir, "..", "..", "public", "mcp-brand-logo.svg")
}

function resolveBrandIcon192Path(): string {
  return join(moduleDir, "..", "..", "public", "mcp-brand-icon-192.png")
}

function readBrandSvg(): string | null {
  const path = resolveBrandLogoPath()
  if (!existsSync(path)) return null
  return readFileSync(path, "utf8")
}

function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Public path (same origin as MCP) for clients that fetch icons by URL. */
export const MCP_BRAND_LOGO_PATH = "/.well-known/ctxpipe/mcp-brand-logo.svg"

/** PNG first in `icons` so UIs that skip SVG / data URIs still show the mark. */
export const MCP_BRAND_ICON_192_PATH = "/.well-known/ctxpipe/mcp-brand-icon-192.png"

const implementationByBaseUrl = new Map<string, Implementation>()

export function getMcpServerImplementation(
  authBaseUrl: string | undefined,
): Implementation {
  const base = (authBaseUrl?.trim() || "https://localhost:3000").replace(
    /\/$/,
    "",
  )
  const hit = implementationByBaseUrl.get(base)
  if (hit) return hit

  const svg = readBrandSvg()
  const urlIcon = `${base}${MCP_BRAND_LOGO_PATH}`
  const urlPng = `${base}${MCP_BRAND_ICON_192_PATH}`
  const hasPng = existsSync(resolveBrandIcon192Path())

  const icons: NonNullable<Implementation["icons"]> = []
  if (hasPng) {
    icons.push({
      src: urlPng,
      mimeType: "image/png",
      sizes: ["192x192"],
    })
  }
  if (svg !== null) {
    icons.push({
      src: svgToDataUri(svg),
      mimeType: "image/svg+xml",
      sizes: ["196x106"],
    })
  }
  icons.push({ src: urlIcon, mimeType: "image/svg+xml" })

  const impl: Implementation = {
    name: "ctxpipe",
    title: "ctx|",
    version: "0.1.0",
    websiteUrl: base,
    icons,
  }
  implementationByBaseUrl.set(base, impl)
  return impl
}

export function getMcpBrandLogoAbsolutePath(): string {
  return resolveBrandLogoPath()
}

export function getMcpBrandIcon192AbsolutePath(): string {
  return resolveBrandIcon192Path()
}
