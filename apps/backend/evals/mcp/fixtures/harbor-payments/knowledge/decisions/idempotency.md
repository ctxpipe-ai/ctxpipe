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

The [ticket](../../linear/teams/HBR/issues/hbr-17--7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5.md) records the defect.
