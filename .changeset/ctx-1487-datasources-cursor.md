---
"@ctxpipe/aws-cdk": patch
---

The `datasources-infra` skill of ingestion writes its store and infrastructure files with a script from a plan of the model, and it refuses a store that its finder did not list. It pages by a cursor over the stores of its finder, and no skill has a limit of 20 pages. The finder also finds Valkey, Infinispan, FalkorDB, the Keyv stores of Redis and Memcached, and the `pgvector` image of PostgreSQL (CTX-1487).
