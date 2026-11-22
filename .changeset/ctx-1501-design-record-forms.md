---
"@ctxpipe/aws-cdk": patch
---

Ingestion now writes a decision file for each design record that is not an ADR: a KEP (`README.md` with `kep.yaml`), an RFC (a numbered file in `rfcs/`, `proposals/`, or the `text/` folder of an RFC process), a PEP, and a file in a design folder such as `docs/design/`. Each decision file has the status of its process (for example provisional, implementable, implemented, postponed, or withdrawn) and its declared supersede links (CTX-1501).
