---
"@ctxpipe/aws-cdk": patch
---

Dependency updates: the worker image runs Forge CLI 15.1.0 to set up the Confluence app. Connectors make file names with `@sindresorhus/slugify` 4: an emoji, a Turkish or Azerbaijani letter, a combining mark or a backslash in a title can give a new file name on the next sync. The workspace file tree uses `@pierre/trees` 1.0, and Escape in its search puts focus back on the selected file.
