---
"@ctxpipe/aws-cdk": patch
---

Keep codesearch file reads, listings and globs inside the repository checkout. Codesearch follows a symlink only when its real target is inside the checkout. It answers other symlinks as a missing file.
