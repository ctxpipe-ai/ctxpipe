---
kind: Runbook
---
# Replay settlement events

1. Stop the settlement consumer.
2. Check the idempotency key in the ledger.
3. Replay only events with no stored key.
4. Start the consumer.

See the [incident](../../pagerduty/incidents/HBR-3.md).
