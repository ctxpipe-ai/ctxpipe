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
      "Space comes from the Tailwind scale. A group has more space around it than within it. A label is closer to its field than one field group is to the next. A heading is closer to its own content than to the block above it. Text does not touch the edge of its button, card, pill or page.",
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
      "UI text is Geist; ids, paths, hashes and counts are Geist Mono. Body is text-sm, meta is text-xs, a product title is text-lg or text-xl. No text is smaller than text-xs (12 px). Weights are 400 and 500 only. Sizes come from the Tailwind scale. Prose lines stay at about 75 characters or less. A title of two or more lines does not end with one word alone.",
    sources: [design("Type"), craft("Type"), craft("Space and layout")],
  },
  {
    id: "overflow",
    name: "Overflow and truncation",
    definition:
      "Text, icons and focus rings fit their box. Nothing is cut off by a parent, nothing runs over a neighbor, and no element covers text.",
    sources: [design("Focus / keyboard"), craft("Finishing")],
  },
  {
    id: "contrast",
    name: "Contrast",
    definition:
      "Text is readable on its surface: about 4.5:1 for body text and 3:1 for large text and icons. On a teal, red or amber slab, secondary text is a lighter stop of the same hue at full opacity, not white at reduced opacity.",
    sources: [design("Color"), craft("Color on color")],
  },
  {
    id: "alignment",
    name: "Alignment",
    definition:
      "Items in one column share one left edge. Long copy is left-aligned, never justified. Numbers are right-aligned with tabular figures. Mixed type on one row shares a baseline.",
    sources: [craft("Space and layout")],
  },
  {
    id: "missing-elements",
    name: "Missing elements",
    definition:
      "An addition or deletion region adds or removes an element. A label, an icon, a status word or a control does not disappear without a reason. A status keeps its dot and its word.",
    sources: [design("Targets (new or touched UI)")],
  },
  {
    id: "broken-content",
    name: "Broken content",
    definition:
      "Labels, copy and field values show no rendering artifact: no undefined, null, NaN, [object Object], untranslated key, lorem ipsum or broken image. A code or file preview that shows such text as content is not broken.",
    sources: [craft("Finishing")],
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
      'The user can tell what each element is and what it does. Copy is plain and specific, with no marketing claims. A button names its result with a verb and an object ("Save token", not "Submit"). Each form field has a visible label, not only a placeholder. A status shows its word, not only a color.',
    sources: [
      design("Personality (copy these)"),
      design("Targets (new or touched UI)"),
      craft("Finishing"),
      tells("Tells to remove"),
    ],
    pageOnly: false,
  },
  {
    id: "hierarchy",
    name: "Hierarchy",
    definition:
      "One element leads: the title is the loudest ink. Hierarchy comes from weight and muted color, not from a size jump. Neighbors and decorative icons are muted first. Items of different importance do not get the same weight, as in a grid of equal cards.",
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
      "The change reuses the house primitives and patterns: one corner radius (rounded-md), the button variants, the status pill. No new font, hex color, corner treatment, shadow or card style.",
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
      "No AI tells: no gradient, gradient text, glass, grain, glow or grid on product chrome, no hero type, no four equal KPI tiles, no teal on every row, no colored stripe on one side of a card, no hard offset or wide black shadow on an in-page card, no badge stacked above a title. A dialog, popover, menu or toast keeps its house shadow. No icon tile above the heading of an empty state. A status dot pulses only for a live state (running, syncing, indexing). These are not tells: the mono uppercase .ctx-label as a section label in a dense panel (not as an eyebrow above a page title or a card heading), the corner crosses on a hero or summary card, and a status dot with its word.",
    sources: [tells("Tells to remove"), tells("Brand, not tells")],
    pageOnly: false,
  },
  {
    id: "brand-fit",
    name: "Brand fit",
    definition:
      "The surface reads as the ctxpipe Operate UI: dark zinc floor, white primary, teal accent, Geist type, monospace for ids, paths, hashes and counts. Large type and atmosphere stay on onboarding.",
    sources: [design("Personality (copy these)"), tells("Ceiling vs Operate")],
    pageOnly: false,
  },
] as const satisfies readonly (RubricEntry & { pageOnly: boolean })[]

export type AreaId = (typeof areas)[number]["id"]
export type QualityId = (typeof qualities)[number]["id"]
