// The page tag and the route of each story in a story file. The page story
// check (scripts/ci/check-page-stories.mjs) and `visual:review` (the scope of
// a screenshot) read the tags with this one parser.

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

/** One story: its export name, its page tag and its route string. */
type StoryTags = { name: string; page: boolean; route: string | null }

/** The strings of an array node, or `[]`. */
const stringsOf = (node: Node | undefined) =>
  node?.type === "ArrayExpression"
    ? (node.elements ?? []).flatMap((element) =>
        element?.type === "StringLiteral" ? [String(element.value)] : [],
      )
    : []

/** The value node of `parameters.route` in an annotations object. */
const routeOf = (annotations: Annotations) =>
  annotations?.parameters?.properties?.find(
    (property) =>
      property.type === "ObjectProperty" &&
      (property.key?.name ?? property.key?.value) === "route",
  )?.value as Node | undefined

/**
 * Each story of the story file `file` with the text `code`. A story has the
 * page tag when its `meta` or the story has it, and the story does not
 * remove it with `"!page"`. A story's own route wins over the route of the
 * `meta`.
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
    _metaAnnotations: Annotations
    _stories: Record<string, unknown>
    _storyAnnotations: Record<string, Annotations>
  }
  const meta = csf._metaAnnotations
  return Object.keys(csf._stories).map((name) => {
    const annotations = csf._storyAnnotations[name]
    const tags = new Set<string>()
    for (const tag of [
      ...stringsOf(meta?.tags),
      ...stringsOf(annotations?.tags),
    ])
      if (tag.startsWith("!")) tags.delete(tag.slice(1))
      else tags.add(tag)
    const route = routeOf(annotations) ?? routeOf(meta)
    return {
      name,
      page: tags.has("page"),
      route: route?.type === "StringLiteral" ? String(route.value) : null,
    }
  })
}
