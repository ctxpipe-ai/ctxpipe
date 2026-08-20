---
"ctxpipe": patch
---

Stop Cursor memory capture from recapturing Stop `followup_message` as a new lesson. Ignore follow-up-shaped payloads (including nested prompt JSON), honor Cursor `loop_count`, and cap the stop hook at one auto follow-up.
