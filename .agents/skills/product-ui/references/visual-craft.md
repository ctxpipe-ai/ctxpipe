# Visual craft (build checks)

Yes/no checks in our voice. Apply every row to the UI you just built (skill step 8), after the rule sections of [`DESIGN.md`](../../../../apps/ui/DESIGN.md). N/A is allowed when the surface has no type / form / image / etc.

This file holds only the build craft that `DESIGN.md` and the steps of the skill do not. Each rule is in one place: do not copy a rule here. These checks encode widely used interface tactics as house rules. They are not a reprint of any book.

## Hierarchy and type

| Check | Yes looks like |
|-------|----------------|
| Labels supporting | Drop “Name:” when the value is obviously a name; combine (“12 left”). Flip only when the user scans for the *label* |
| Links in a dense list | Weight or a darker color; hover-only for an ancillary link |

## Space and layout

| Check | Yes looks like |
|-------|----------------|
| Chrome width | AppShell sidebar stays fixed; do not percentage-size chrome |
| Independent scales | Type in rem/px; button padding is its own scale (tighter when the control is small). No `em`-tied padding |
| Overlap | Only if the nearby anchor screen already overlaps |

## Images

| Check | Yes looks like |
|-------|----------------|
| Figures | Crop to a fixed frame / `object-cover`; do not scale a screenshot until type is 4px |
| User art | Fixed frame + inner edge so avatars/logos do not bleed into zinc-950 |
