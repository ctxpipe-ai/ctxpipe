-- TanStack AI 1.x (CTX-1580) resumes only the interrupts whose metadata holds
-- `tanstack:interruptBinding`. 0.63.0, the release before 1.x, writes the
-- binding. A row without one (from an earlier 0.x release, or written by
-- another tool) can never resume and would stay pending. Cancel those rows.
-- We expect none. The notice logs only the count: no ids, no payloads. A second
-- run changes no row: each row it cancels is no longer pending.
DO $$
DECLARE
  cancelled integer;
BEGIN
  UPDATE "chat_interrupts"
  SET
    "status" = 'cancelled',
    "resolved_at" = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
  WHERE "status" = 'pending'
    AND NOT coalesce(
      jsonb_typeof("payload_json" -> 'metadata') = 'object'
        AND ("payload_json" -> 'metadata') ? 'tanstack:interruptBinding',
      false
    );
  GET DIAGNOSTICS cancelled = ROW_COUNT;
  RAISE NOTICE 'cancelled % unbound pending chat interrupt(s)', cancelled;
END $$;
