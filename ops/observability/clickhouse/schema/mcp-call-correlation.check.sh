#!/usr/bin/env bash
# Check mcp-call-correlation.sql in clickhouse-local (the production image).
# Needs Docker. Exit code 0 when the derived sessions and turns are correct.
#
#   bash ops/observability/clickhouse/schema/mcp-call-correlation.check.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
image="$(awk '/^FROM /{print $2; exit}' "$here/../Dockerfile")"

expected="$(cat <<'EOF'
a1	1	1	production:conn_a:s1
a2	1	1	production:conn_a:s1
a3	1	1	production:conn_a:s1
a4	1	2	production:conn_a:s1
a5	2	3	production:conn_a:s2
a6	2	3	production:conn_a:conv-x
b1	1	1	production:conn_b:s1
b2	1	1	production:conn_b:conv-x
c1	1	1	pr-1:conn_a:s1
EOF
)"

setup="$(cat <<'SQL'
CREATE DATABASE otel;
CREATE TABLE otel.otel_traces
(
    Timestamp DateTime64(9),
    DeploymentEnvironment LowCardinality(String),
    ServiceName LowCardinality(String),
    TraceId String,
    SpanId String,
    SpanName LowCardinality(String),
    Duration UInt64,
    StatusCode LowCardinality(String),
    SpanAttributes Map(LowCardinality(String), String)
) ENGINE = Memory;

INSERT INTO otel.otel_traces VALUES
    -- One turn: two parallel calls, then a call 30 s later.
    ('2026-01-01 00:00:00.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a1'}),
    ('2026-01-01 00:00:00.005', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool get_unit', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a2'}),
    ('2026-01-01 00:00:30.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool get_unit', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a3'}),
    -- A 90 s gap starts a new turn in the same session.
    ('2026-01-01 00:02:00.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a4'}),
    -- A 38 min gap starts a new session; the client id wins for a6.
    ('2026-01-01 00:40:00.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a5'}),
    ('2026-01-01 00:40:00.010', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'a6', 'ctxpipe.mcp.conversation.id': 'conv-x'}),
    -- Another connection key and another environment have their own sessions.
    ('2026-01-01 00:00:00.003', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_b', 'ctxpipe.mcp.call.id': 'b1'}),
    -- The same client conversation id from another principal stays apart.
    ('2026-01-01 00:00:10.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_b', 'ctxpipe.mcp.call.id': 'b2', 'ctxpipe.mcp.conversation.id': 'conv-x'}),
    ('2026-01-01 00:00:01.000', 'pr-1', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'c1'}),
    -- Not in the view: another span, no connection key, out of range.
    ('2026-01-01 00:00:00.001', 'production', 'ctxpipe-backend', 't', 's', 'POST /mcp', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'x1'}),
    ('2026-01-01 00:00:00.001', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.call.id': 'x2'}),
    ('2026-01-02 00:00:00.000', 'production', 'ctxpipe-backend', 't', 's', 'mcp.tool search_context', 1, 'Ok', {'ctxpipe.mcp.connection.key': 'conn_a', 'ctxpipe.mcp.call.id': 'x3'});
SQL
)"

query="SELECT CallId, SessionSeq, TurnSeq, ConversationId
FROM otel.mcp_tool_calls(from = '2026-01-01 00:00:00', to = '2026-01-01 23:59:59')
ORDER BY CallId FORMAT TSV"

actual="$(printf '%s\n%s\n%s;\n' "$setup" "$(cat "$here/mcp-call-correlation.sql")" "$query" |
  docker run --rm -i --entrypoint clickhouse "$image" local --multiquery)"

if [ "$actual" != "$expected" ]; then
  echo "mcp-call-correlation.sql: unexpected result" >&2
  diff <(echo "$expected") <(echo "$actual") >&2 || true
  exit 1
fi
echo "mcp-call-correlation.sql: ok"
