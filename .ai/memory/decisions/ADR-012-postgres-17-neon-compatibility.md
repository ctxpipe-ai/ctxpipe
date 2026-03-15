# ADR-012: PostgreSQL 17 for Neon Compatibility

**Status:** Accepted | **Date:** 2026-03-15 | **Tags:** databases, postgres, neon

## Context

Production uses Neon for PostgreSQL. Neon offers PostgreSQL 18 only in beta, and does not yet support `pg_search` in pg18. We need a stable, production-ready Postgres version that aligns local development with Neon.

## Decision

Use **PostgreSQL 17** everywhere:

- **Local dev** ([docker-compose.yml](../../../docker-compose.yml)): `pgvector/pgvector:pg17`
- **Production (Neon)**: Neon project configured for PostgreSQL 17

## Consequences

- Local and production use the same Postgres version.
- Full-text search (tsvector/tsquery) and pgvector work as expected.
- We can move to pg18 when Neon supports it fully and `pg_search` is available.

## Notes

- See [ADR-004](ADR-004-local-development-docker-compose.md) for local dev setup. ADR-004 is partially outdated (postgres image); the actual image is defined in `docker-compose.yml`.
