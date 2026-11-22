---
---

The slowest backend tests take less time: the ingest skill scripts read git in batches, the backend tests load the production build of each package, and the ingestion v2 publish test is three files that shards run at the same time (CTX-1560).
