---
---

The merge gate pins a new factory release. In that release, the variant A selection record has no `trace` key. The trace lookup asks for nightly and manual runs by event. Without a trace, the gate uses the variant A selection and not full mode. Operators see no change.
