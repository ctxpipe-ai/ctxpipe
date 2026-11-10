---
"@ctxpipe/aws-cdk": patch
---

The codesearch image now has scip-clang and scip-ruby on linux/arm64 too. Both indexers are built on Debian Bookworm, so scip-clang also starts on linux/amd64 again: the upstream binary needed a newer GLIBC than the image has.
