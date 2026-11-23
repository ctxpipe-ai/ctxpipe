---
"@ctxpipe/aws-cdk": patch
---

Knowledge plane: a slow Jev call sends a second copy of its request after 700 ms, and the first copy that ends gives the result. This cuts the get_related tail latency and adds about 2% more Jev calls (CTX-1590).
