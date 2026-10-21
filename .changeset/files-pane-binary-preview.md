---
"@ctxpipe/aws-cdk": patch
---

The Files pane shows a preview of PNG, JPEG, GIF, WebP, and SVG images, and lets users download other binary files. New raw file endpoints for a Workspace and a conversation send the file bytes, with a 10 MB limit. Codesearch does not read a file that is larger than this limit for these endpoints. Update the backend and codesearch images together.
