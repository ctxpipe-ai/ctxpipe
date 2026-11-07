// The two-layer rubric of the visual critic. Each entry cites the section of
// our design docs that it comes from. A test makes sure that each cited
// section exists, so a renamed heading fails the test.

/** A section of a design doc: the repo path and the exact heading text. */
type RubricSource = { file: string; section: string }

export type RubricEntry = {
  id: string
  name: string
  definition: string
  sources: readonly RubricSource[]
}

const design = (section: string) => ({ file: "apps/ui/DESIGN.md", section })
const craft = (section: string) => ({
  file: ".agents/skills/product-ui/references/visual-craft.md",
  section,
})
const tells = (section: string) => ({
  file: ".agents/skills/product-ui/references/ai-tells.md",
  section,
})
const skill = (section: string) => ({
  file: ".agents/skills/product-ui/SKILL.md",
  section,
})

/** Layer 1: the concrete areas. A finding names one of them as its `kind`. */
export const areas = [
  {
    id: "spacing",
    name: "Spacing",
    definition:
      "Space comes from the Tailwind scale. A group has more space around it than within it. A label is closer to its field than one field group is to the next.",
    sources: [design("Space"), craft("Space and layout")],
  },
  {
    id: "color-tokens",
    name: "Color tokens",
    definition:
      "Color comes from the house tokens: a zinc floor, a white primary, a teal accent, and the destructive red only on a confirm dialog. No indigo, no purple gradient, no second accent.",
    sources: [design("Color")],
  },
  {
    id: "typography",
    name: "Typography",
    definition:
      "UI text is Geist; ids, paths, hashes and counts are Geist Mono. Body is text-sm, meta is text-xs, a product title is text-lg or text-xl. Weights are 400 and 500 only. Sizes come from the Tailwind scale.",
    sources: [design("Type"), craft("Type")],
  },
  {
    id: "overflow",
    name: "Overflow and truncation",
    definition:
      "Text, icons and focus rings fit their box. Nothing is cut off by a parent, and nothing runs over a neighbor.",
    sources: [design("Focus / keyboard"), craft("Finishing")],
  },
  {
    id: "contrast",
    name: "Contrast",
    definition:
      "Text is readable on its surface. On a teal, red or amber slab, secondary text is a lighter stop of the same hue at full opacity, not white at reduced opacity.",
    sources: [design("Color"), craft("Color on color")],
  },
  {
    id: "alignment",
    name: "Alignment",
    definition:
      "Long copy is left-aligned. Numbers are right-aligned with tabular figures. Mixed type on one row shares a baseline.",
    sources: [craft("Space and layout")],
  },
  {
    id: "missing-elements",
    name: "Missing elements",
    definition:
      "An addition or deletion region adds or removes an element. A label, an icon, a status word or a control does not disappear without a reason. A status keeps its dot and its word.",
    sources: [design("Targets (new or touched UI)")],
  },
] as const satisfies readonly RubricEntry[]

/**
 * Layer 2: the design qualities. For each one, the critic says if the change
 * makes it better, the same or worse. A `pageOnly` quality applies only to a
 * story with the scope `page`.
 */
export const qualities = [
  {
    id: "clarity",
    name: "Clarity",
    definition:
      "The user can tell what each element is and what it does. Copy is plain and specific. A status shows its word, not only a color.",
    sources: [
      design("Personality (copy these)"),
      design("Targets (new or touched UI)"),
    ],
    pageOnly: false,
  },
  {
    id: "hierarchy",
    name: "Hierarchy",
    definition:
      "Hierarchy comes from weight and muted color, not from a size jump. The title is the loudest ink. Neighbors and decorative icons are muted first.",
    sources: [craft("Hierarchy"), skill("4. Hierarchy + layout pass")],
    pageOnly: false,
  },
  {
    id: "focus",
    name: "Focus",
    definition:
      "The page has one primary action: one filled white button. Other actions are outline, quiet or a link. Teal marks only the one real action in a dense list.",
    sources: [design("Targets (new or touched UI)"), craft("Actions")],
    pageOnly: true,
  },
  {
    id: "consistency",
    name: "Consistency",
    definition:
      "The change reuses the house primitives and patterns: one corner radius (rounded-md), the button variants, the status pill, the .ctx-label. No new font, hex color, corner treatment or card style.",
    sources: [design("Personality (copy these)"), design("What not to invent")],
    pageOnly: false,
  },
  {
    id: "grouping-and-rhythm",
    name: "Grouping and rhythm",
    definition:
      "Related items sit together, with more space around a group than within it. A gap or a background shift separates groups first, then one hairline. No card inside a card.",
    sources: [design("Space"), design("Targets (new or touched UI)")],
    pageOnly: false,
  },
  {
    id: "density",
    name: "Density",
    definition:
      "Operate density, as in chat, connectors and settings: tight, not landing-page air. Forms and prose keep a maximum width; data surfaces are full width.",
    sources: [design("Space"), craft("Space and layout")],
    pageOnly: false,
  },
  {
    id: "feedback-and-state",
    name: "Feedback and state",
    definition:
      "Each state uses its house pattern. A region wait is a skeleton with the box of the loaded state. A process wait is the teal loader. An empty state is a short title, one sentence and one primary control. An error is an inline alert with a next step.",
    sources: [design("Loading states"), skill("6. Plan states")],
    pageOnly: false,
  },
  {
    id: "accessibility",
    name: "Accessibility",
    definition:
      "The focus ring is readable (2 px, teal at 60%) and not clipped. Status is not color-only. Quiet text uses color or size, never a weight below 400.",
    sources: [design("Focus / keyboard"), craft("Color on color")],
    pageOnly: false,
  },
  {
    id: "restraint",
    name: "Restraint",
    definition:
      "No AI tells: no gradient, glass, grain, glow or grid on product chrome, no hero type, no four equal KPI tiles, no teal on every row. The house brand signatures are not tells.",
    sources: [tells("Tells to remove"), tells("Brand, not tells")],
    pageOnly: false,
  },
  {
    id: "brand-fit",
    name: "Brand fit",
    definition:
      "The surface reads as the ctxpipe Operate UI: dark zinc floor, white primary, teal accent, Geist type, card corner crosses, mono labels. Large type and atmosphere stay on onboarding.",
    sources: [design("Personality (copy these)"), tells("Ceiling vs Operate")],
    pageOnly: false,
  },
] as const satisfies readonly (RubricEntry & { pageOnly: boolean })[]

export type AreaId = (typeof areas)[number]["id"]
export type QualityId = (typeof qualities)[number]["id"]
