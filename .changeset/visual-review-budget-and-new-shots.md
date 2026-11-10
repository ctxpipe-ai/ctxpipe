---
---

`visual:review` gets `--budget-usd <n>`: the command stops its own model calls when the spent cost reaches the budget, marks each screenshot that it did not judge `unsure` with the error "Budget reached", and exits with code 2. A call with no `usage.cost` counts as 0.25 USD. A new screenshot (no base image) is judged on its own against the rubric, in one call for the new screenshots of one story. The bake-off dataset gets a `new` case kind: a story that a commit added, with only its after image, clean or with a synthetic regression.
