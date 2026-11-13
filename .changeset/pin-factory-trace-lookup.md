---
---

The merge gate pins a factory release whose variant A selection record has no `trace` key, and whose trace lookup asks for nightly and manual runs by event. Without a trace, the gate now uses the variant A selection instead of full mode. No operator-visible change.
