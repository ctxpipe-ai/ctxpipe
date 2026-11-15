// The page tag, the route and the review annotations of each story in a story
// file. The page story check (scripts/ci/check-page-stories.mjs), the story
// review check (scripts/ci/check-story-review.mjs), the visual check (the
// manifest) and `visual:review` (what the critic knows about a screenshot)
// read them with this one parser.

/** The few Babel node fields that the parser reads. */
type Node = {
  type: string
  value?: unknown
  elements?: readonly (Node | null)[]
  properties?: readonly Node[]
  key?: { name?: string; value?: unknown }
}
type Annotations = Record<string, Node | undefined> | undefined

/** `loadCsf` of `storybook/internal/csf-tools`. */
type LoadCsf = (
  code: string,
  options: { fileName: string; makeTitle: (title: string) => string },
) => { parse(): unknown }

/** How the critic judges a screenshot of the story (`parameters.review.kind`). */
export type StoryKind = "page" | "component"

/**
 * One story: its export name, its Storybook name (`<title> / <name>`), its
 * page tag, its route string, and its review annotations. `kind` and
 * `purpose` are null when the story does not have a valid literal value.
 */
type StoryTags = {
  name: string
  label: string
  page: boolean
  route: string | null
  kind: StoryKind | null
  purpose: string | null
}

/** The strings of an array node, or `[]`. */
const stringsOf = (node: Node | undefined) =>
  node?.type === "ArrayExpression"
    ? (node.elements ?? []).flatMap((element) =>
        element?.type === "StringLiteral" ? [String(element.value)] : [],
      )
    : []

/** The value node of the property `key` of an object node. */
const propertyOf = (node: Node | undefined, key: string) =>
  node?.properties?.find(
    (property) =>
      property.type === "ObjectProperty" &&
      (property.key?.name ?? property.key?.value) === key,
  )?.value as Node | undefined

/** The string of a string literal node, or null. */
const stringOf = (node: Node | undefined) =>
  node?.type === "StringLiteral" ? String(node.value) : null

/** The value node of `parameters.review.<key>` in an annotations object. */
const reviewOf = (annotations: Annotations, key: "kind" | "purpose") =>
  propertyOf(propertyOf(annotations?.parameters, "review"), key)

/**
 * Each story of the story file `file` with the text `code`. A story has the
 * page tag when its `meta` or the story has it, and the story does not
 * remove it with `"!page"`. A story's own route wins over the route of the
 * `meta`. The kind (`parameters.review.kind`) comes from the story or else
 * from the `meta`. The purpose (`parameters.review.purpose`) comes only from
 * the story: it says what state that story shows.
 */
export function storiesOf(
  loadCsf: LoadCsf,
  file: string,
  code: string,
): StoryTags[] {
  const csf = loadCsf(code, {
    fileName: file,
    makeTitle: (title) => title ?? file,
  }).parse() as {
    _meta?: { title?: string }
    _metaAnnotations: Annotations
    _stories: Record<string, { name?: string }>
    _storyAnnotations: Record<string, Annotations>
  }
  const meta = csf._metaAnnotations
  return Object.entries(csf._stories).map(([name, story]) => {
    const annotations = csf._storyAnnotations[name]
    const tags = new Set<string>()
    for (const tag of [
      ...stringsOf(meta?.tags),
      ...stringsOf(annotations?.tags),
    ])
      if (tag.startsWith("!")) tags.delete(tag.slice(1))
      else tags.add(tag)
    const route =
      propertyOf(annotations?.parameters, "route") ??
      propertyOf(meta?.parameters, "route")
    const kind = stringOf(
      reviewOf(annotations, "kind") ?? reviewOf(meta, "kind"),
    )
    const purpose = stringOf(reviewOf(annotations, "purpose"))?.trim()
    return {
      name,
      label: `${csf._meta?.title ?? file} / ${story.name ?? name}`,
      page: tags.has("page"),
      route: stringOf(route),
      kind: kind === "page" || kind === "component" ? kind : null,
      purpose: purpose || null,
    }
  })
}
