---
kind: Service
title: Settlement service
claims:
  - to: ledger.md
    predicate: DEPENDS_ON
    confidence: 0.9
    source: human
---
# Settlement service

The settlement service submits each payment once. It uses an idempotency key.

Read the [decision](../decisions/idempotency.md), the [runbook](../operations/replay.md), and the [ledger](ledger.md).
