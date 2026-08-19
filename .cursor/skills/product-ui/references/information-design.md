# Information design (house catalog)

Read this when translating intent (skill step 3). Teach the *method* in `SKILL.md`; this file is the mapping. Cite our own screens so agents copy DNA instead of inventing a third card style.

Icons: `@tabler/icons-react`. Decorative icons get `aria-hidden`. The visible title carries the meaning — the icon is a scan affordance, not the label.

## Intent → pattern

| Intent words | Job | Designed pattern (this repo) | Do not default to |
|--------------|-----|------------------------------|-------------------|
| list, features, includes, what you get | scan 2–7 capabilities | Icon + title + one-line body rows; quiet dividers; Tabler icons at ~16–20px | `list-disc` `ul/li` |
| steps, then, after you | learn a sequence | Numbered markers + action copy — [LinearTargetStep](../../../../apps/ui/src/features/connectors/components/linear-setup/LinearTargetStep.tsx), [NotionSetupDialog](../../../../apps/ui/src/features/connectors/components/NotionSetupDialog.tsx) | paragraph soup or unnumbered bullets |
| choose, pick, add a source | act on one of N | Catalog rows / cards in a `ul` that is a **layout**, not a disc list — [AddConnectorCatalogDialog](../../../../apps/ui/src/features/connectors/components/AddConnectorCatalogDialog.tsx) | radio stack or raw links |
| conversations, rows, many items | browse + select | [GridList](../../../../apps/ui/src/components/ui/GridList.tsx) / [ListBox](../../../../apps/ui/src/components/ui/ListBox.tsx); virtualize past ~50 | `.map` of `<div>` or disc `ul` |
| status, health, sync | read state at a glance | Pill / [RepositoryStatus](../../../../apps/ui/src/features/repositories/components/RepositoryStatus.tsx) — pulse/dot **and** the word | colored `<span>` or emoji |
| empty, none yet, get started | invite one action | Title + one sentence + one **primary** control; hide tabs/filters until there is content. Improve toward this from [ConnectorsEmptyState](../../../../apps/ui/src/features/connectors/components/ConnectorsEmptyState.tsx) | “No items” plus dead chrome; outline-only CTA |
| error, failed, couldn’t | recover | [InlineAlert](../../../../apps/ui/src/components/ui/InlineAlert.tsx) + next step | red text under the fold |
| form, fields, configure | enter data | `Field` / `TextField` / `ComboBox` groups with labels; sections + proximity | unlabeled `<input>` stack |
| settings, preferences | find + change | Section headings + grouped rows, not one flat column | full-bleed unlabeled fields |
| confirm, delete, disconnect | decide with blast radius | [AlertDialog](../../../../apps/ui/src/components/ui/AlertDialog.tsx); type-to-confirm if irreversible | `window.confirm`; filled red on the page |
| loading | wait without layout jump | Skeleton that mirrors the final pattern | “Loading…” |
| id, hash, path, shortcut | read a token | Geist Mono; `tabular-nums` on counts | body sans for data |
| help, note, explain | unblock without a lecture | One supporting line; link out if needed | wall of `<p>` |

## When a plain `ul` is correct

Inline prose (a sentence that happens to have three items), legal/consent scope dumps, or a true outline inside a help paragraph. [KnowledgeGraphIntroCallout](../../../../apps/ui/src/features/knowledge-graph/KnowledgeGraphIntroCallout.tsx) is this exception. Feature / benefit / capability copy is not.

A `ul` used as a **layout** (catalog rows, icon rows, GridList) is fine — the failure is `list-disc` on product capabilities.

## Forms

- Label sits next to its control; the gap inside a field is smaller than the gap between field groups.
- Group related fields under a section heading. Space *above* the heading is larger than space below it.
- Narrow form: `max-w-*` on the fields. Optional **second column** for help — do not widen the inputs to fill the nav.
- Complex forms: sections + proximity, not one unlabeled column.

## Tables

- Combine related cells (name + supporting line in one cell) instead of one field per column.
- Right-align + `tabular-nums` on number columns.
- One protagonist metric if this is a dashboard; do not lead with four equal KPI tiles.

## Choices (radios, dropdowns, cards)

- 2–7 peers the user *picks*: selectable catalog rows / cards, not a native radio stack.
- Menus: sections + supporting text, not a flat list of links. Use existing `Menu` / `ListBox` primitives.
- Brand the selected state on React Aria controls. Do not invent a new checkbox.

## Dashboards

One number (or row) is the protagonist. Supporting figures are quieter. Four equal stat strips are a tell — see [ai-tells.md](ai-tells.md).
