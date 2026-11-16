---
---

The Storybook play and screenshot checks do not list the root `package.json` as an input. A change to a root script no longer selects the whole visual lane. The merge gate pins the factory release that treats each own input of a selected check as covered, so a change to the desktop and the mobile baseline of one story selects only that story.
