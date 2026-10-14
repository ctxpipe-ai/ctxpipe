---
title: Reject duplicate settlement
---
# Reject duplicate settlement

A retry without an idempotency key can submit a payment twice. Require a key before ledger writes.

Affected service: [settlement](../../knowledge/services/settlement.md).
