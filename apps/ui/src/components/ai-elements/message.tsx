"use client"

import { cjk } from "@streamdown/cjk"
import { code } from "@streamdown/code"
import { math } from "@streamdown/math"
import { mermaid } from "@streamdown/mermaid"

type ChatMessageRole = "system" | "user" | "assistant"

import { IconExternalLink } from "@tabler/icons-react"
import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { memo, useMemo } from "react"
import { Button as AriaButton } from "react-aria-components"
import { defaultRehypePlugins, Streamdown } from "streamdown"
import { focusVisibleClassName } from "@/lib/focus-styles"
import { cn } from "@/lib/utils"
import {
  workspaceFilePath,
  workspaceFilePathFromHref,
} from "@/lib/workspace-file-path"

type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: ChatMessageRole
}

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[85%] flex-col gap-1",
      from === "user" ? "is-user" : "is-assistant",
      className,
    )}
    {...props}
  />
)

type MessageContentProps = HTMLAttributes<HTMLDivElement>

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-full min-w-0 max-w-full flex-col gap-2 text-sm leading-relaxed",
      /* User bubble: clip to rounded-md box. Assistant: no overflow-y clip so Streamdown code
         block sticky copy/download controls (negative top offset) stay visible and clickable. */
      "group-[.is-user]:overflow-hidden",
      "group-[.is-assistant]:overflow-visible",
      "group-[.is-user]:rounded-md group-[.is-user]:bg-zinc-900 group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground",
      /* Assistant: do not set text colour on this wrapper — it flattens Streamdown/Shiki token
         spans that use color: var(--sdm-c, inherit). Body copy colour comes from Streamdown + CSS. */
      "group-[.is-assistant]:rounded-md group-[.is-assistant]:bg-transparent group-[.is-assistant]:p-0",
      className,
    )}
    {...props}
  >
    {children}
  </div>
)

export type AnswerFileLinks = {
  resolve: (path: string) => string | null
  open: (path: string) => void
}

type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  /**
   * When set, file paths in the answer become buttons. `resolve` gives the
   * tree path for a path in the answer, or null (the text stays text).
   * Keep this value stable: it keys the memoized plugins.
   */
  fileLinks?: AnswerFileLinks
}

const streamdownPlugins = { cjk, code, math, mermaid }

/** Light + dark Shiki themes (required pair for codeToTokens); app is `.dark` so dark slot colours apply. */
const streamdownShikiTheme = ["github-light", "github-dark-dimmed"] as const

type HastNode = {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  value?: string
}

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? ""
  return (node.children ?? []).map(hastText).join("")
}

function fileLinkNode(path: string, children: HastNode[]): HastNode {
  return {
    type: "element",
    tagName: "ctx-file-link",
    properties: { path },
    children,
  }
}

/**
 * Rehype plugin. It runs before sanitize, which removes every `file:` href.
 * It rewrites a `file:///workspace/…` href into the repository-relative path,
 * so the file-link logic handles it. It removes every other `file:` href.
 */
function rewriteFileHrefs() {
  const visit = (node: HastNode) => {
    if (node.type === "element" && node.tagName === "a") {
      const href = String(node.properties?.href ?? "").trim()
      if (/^file:/i.test(href) && node.properties) {
        const sandboxRoot = /^file:\/\/\/workspace\//i
        if (sandboxRoot.test(href)) {
          node.properties.href = href.replace(sandboxRoot, "")
        } else {
          delete node.properties.href
        }
      }
    }
    for (const child of node.children ?? []) visit(child)
  }
  return visit
}

/**
 * Rehype plugin. It adds an icon to off-site links. With `files`, it changes
 * file paths in inline code and relative links into `ctx-file-link` elements.
 * It runs after sanitize, so model HTML cannot make these elements, and
 * before harden, which blocks relative links.
 */
function markAnswerLinks(options: {
  resolve?: (path: string) => string | null
  id?: number
}) {
  const files = options.resolve !== undefined
  const resolve = (path: string | null) =>
    path && options.resolve ? options.resolve(path) : null
  const visit = (parent: HastNode) => {
    parent.children = parent.children?.map((node) => {
      if (node.type !== "element") return node
      if (node.tagName === "a") {
        const href = String(node.properties?.href ?? "")
        if (/^https?:\/\//i.test(href)) {
          node.children = [
            ...(node.children ?? []),
            {
              type: "element",
              tagName: "ctx-external-link-icon",
              properties: {},
              children: [],
            },
          ]
          return node
        }
        const path = files ? resolve(workspaceFilePathFromHref(href)) : null
        if (path) return fileLinkNode(path, node.children ?? [])
        if (files && !href.startsWith("#")) {
          // Harden would show "[blocked]" after a link it cannot keep, so
          // keep only the content of a link that is not a file, http(s) or an
          // in-page anchor.
          const content: HastNode = {
            type: "element",
            tagName: "span",
            properties: {},
            children: node.children ?? [],
          }
          visit(content)
          return content
        }
      }
      if (node.tagName === "code" && parent.tagName !== "pre" && files) {
        const path = resolve(workspaceFilePath(hastText(node)))
        if (path) return fileLinkNode(path, [node])
      }
      visit(node)
      return node
    })
  }
  return visit
}

// Streamdown caches its processor by plugin name and JSON.stringify(options),
// which drops a function. Without a distinct `id` per resolver, every resolver
// would reuse the processor (and the tree) of the first one.
const resolverIds = new WeakMap<object, number>()
const resolverId = (resolve: object) => {
  let id = resolverIds.get(resolve)
  if (id === undefined) {
    id = nextResolverId++
    resolverIds.set(resolve, id)
  }
  return id
}
let nextResolverId = 0

const answerRehypePlugins = (
  resolve?: (path: string) => string | null,
): ComponentProps<typeof Streamdown>["rehypePlugins"] => [
  defaultRehypePlugins.raw,
  ...(resolve ? [rewriteFileHrefs] : []),
  defaultRehypePlugins.sanitize,
  [markAnswerLinks, { resolve, id: resolve && resolverId(resolve) }],
  defaultRehypePlugins.harden,
]
const chatRehypePlugins = answerRehypePlugins()

export const MessageResponse = memo(
  ({
    className,
    isAnimating = false,
    fileLinks,
    ...props
  }: MessageResponseProps) => {
    const components = useMemo(
      () => ({
        "ctx-external-link-icon": () => (
          <IconExternalLink
            aria-hidden
            className="ml-0.5 inline size-3.5 align-text-bottom"
          />
        ),
        "ctx-file-link": ({
          path,
          children,
        }: {
          path?: unknown
          children?: ReactNode
        }) => (
          <AriaButton
            data-ctx-file-link=""
            onPress={() => fileLinks?.open(String(path))}
            className={cn(
              "inline cursor-pointer rounded-md text-left text-teal-400 underline decoration-teal-400/40 underline-offset-2 transition-colors hover:decoration-teal-400",
              focusVisibleClassName,
            )}
          >
            {children}
          </AriaButton>
        ),
      }),
      [fileLinks],
    )
    const rehypePlugins = useMemo(
      () =>
        fileLinks ? answerRehypePlugins(fileLinks.resolve) : chatRehypePlugins,
      [fileLinks],
    )
    return (
      <Streamdown
        {...props}
        className={cn(
          "ctx-streamdown size-full text-sm leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          /* Body copy only — fenced code blocks are not inside these, so Shiki keeps token colours */
          "[&_blockquote]:text-muted-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground [&_li]:text-foreground/90 [&_ol]:text-foreground/90 [&_p]:text-foreground/90 [&_strong]:text-foreground [&_ul]:text-foreground/90",
          "*:data-[streamdown='table-wrapper']:bg-transparent",
          "*:data-[streamdown='table-wrapper']:my-4",
          "*:data-[streamdown='table-wrapper']:p-0",
          "*:data-[streamdown='table-wrapper']:border-0",
          "*:data-[streamdown='table-wrapper']:gap-1",
          "[&>[data-streamdown='table-wrapper']>div:first-child_svg]:h-3",
          "[&>[data-streamdown='table-wrapper']>div:first-child_svg]:w-3",
          className,
        )}
        components={components}
        controls={{ code: true, mermaid: true, table: true }}
        isAnimating={isAnimating}
        plugins={streamdownPlugins}
        rehypePlugins={rehypePlugins}
        shikiTheme={streamdownShikiTheme}
      />
    )
  },
  // Re-render on every streaming delta (children string grows); strict equality hid updates.
)

MessageResponse.displayName = "MessageResponse"
