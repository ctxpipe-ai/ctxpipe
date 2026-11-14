# Visual craft (build checks)

Yes/no checks in our voice. Apply every row to the UI you just built (skill step 8), after the rule sections of [`DESIGN.md`](../../../../apps/ui/DESIGN.md). N/A is allowed when the surface has no type / form / image / etc.

This file holds only the build craft that `DESIGN.md` does not. Each design rule is in `DESIGN.md`, in one place: do not copy a rule here. These checks encode widely used interface tactics as house rules. They are not a reprint of any book.

## Hierarchy and type

| Check | Yes looks like |
|-------|----------------|
| Labels supporting | Drop “Name:” when the value is obviously a name; combine (“12 left”). Flip only when the user scans for the *label* |
| Links in a dense list | Weight or a darker color; hover-only for an ancillary link |

## Space and layout

| Check | Yes looks like |
|-------|----------------|
| One gap for a cluster | The items of one horizontal cluster share one gap |
| Chrome width | AppShell sidebar stays fixed; do not percentage-size chrome |
| Independent scales | Type in rem/px; button padding is its own scale (tighter when the control is small). No `em`-tied padding |
| Overlap | Only if the nearby anchor screen already overlaps |

## Images

| Check | Yes looks like |
|-------|----------------|
| Figures | Crop to a fixed frame / `object-cover`; do not scale a screenshot until type is 4px |
| User art | Fixed frame + inner edge so avatars/logos do not bleed into zinc-950 |

## Build

| Check | Yes looks like |
|-------|----------------|
| Defaults upgraded | React Aria controls; branded selected state; no native radio / default underline as the design |
| No unbuilt chrome | Every control has a backend or was cut from this version |
| Scoped style edits | When polishing one region, do not push experiments into shared class helpers that restyle sibling regions |
| Selected chrome on press | Tab, nav row, and switcher highlight move in the click handler. Skeleton stays inside the region. First HTML still has the landing files/data |
| Keyboard pass | **Tab** the surface once: the rules of DESIGN.md **Focus / keyboard** hold on each control |
