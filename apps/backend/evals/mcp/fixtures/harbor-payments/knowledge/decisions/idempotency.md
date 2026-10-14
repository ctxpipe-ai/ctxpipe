---
kind: Decision
title: Retain idempotency keys for 48 hours
claims:
  - to: ../services/settlement.md
    predicate: GOVERNS
    confidence: 1
    source: human
    valid_from: 2026-01-01T00:00:00Z
---
# Retain idempotency keys for 48 hours

Retries can arrive the next day. Keep each key for 48 hours to prevent duplicate settlement.

The [ticket](../../linear/issues/HBR-17.md) records the defect.
