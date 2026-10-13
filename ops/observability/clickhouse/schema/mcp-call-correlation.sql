-- MCP tool calls with a derived session and turn (ADR-051 section 9).
--
-- One row for each `mcp.tool <name>` span. The backend puts the
-- `ctxpipe.mcp.*` attributes on that span (apps/backend/src/mcp/correlation.ts).
-- The view derives a session and a turn for each connection key:
--   * a new session starts after a gap of more than 30 minutes;
--   * a new turn starts after a gap of more than 60 seconds, or at a new session.
-- Parallel calls of one turn arrive within milliseconds, so they share a turn.
-- When the client sent a conversation or turn id, ConversationId and TurnId
-- use it; the derived ids stay in DerivedSessionId and DerivedTurnId. Each id
-- starts with the environment and the connection key, so the same client id
-- from two principals or two environments does not merge.
--
-- This is a parameterized view. Give the time range, because ClickHouse does
-- not push a filter through window functions:
--   SELECT * FROM otel.mcp_tool_calls(from = now() - INTERVAL 1 DAY, to = now())
-- A session that starts before `from` starts again at `from`.
--
-- Run as the otel user. CREATE OR REPLACE is safe to repeat.

CREATE OR REPLACE VIEW otel.mcp_tool_calls AS
SELECT
    *,
    concat(DeploymentEnvironment, ':', ConnectionKey, ':s',
        toString(SessionSeq)) AS DerivedSessionId,
    concat(DeploymentEnvironment, ':', ConnectionKey, ':t',
        toString(TurnSeq)) AS DerivedTurnId,
    if(ClientConversationId != '',
        concat(DeploymentEnvironment, ':', ConnectionKey, ':',
            ClientConversationId),
        DerivedSessionId) AS ConversationId,
    if(ClientTurnId != '',
        concat(DeploymentEnvironment, ':', ConnectionKey, ':', ClientTurnId),
        DerivedTurnId) AS TurnId
FROM
(
    SELECT
        *,
        sum(toUInt64(PreviousAt IS NULL
            OR dateDiff('millisecond', PreviousAt, Timestamp) > 30 * 60 * 1000))
            OVER calls AS SessionSeq,
        sum(toUInt64(PreviousAt IS NULL
            OR dateDiff('millisecond', PreviousAt, Timestamp) > 60 * 1000))
            OVER calls AS TurnSeq
    FROM
    (
        SELECT
            Timestamp,
            DeploymentEnvironment,
            ServiceName,
            TraceId,
            SpanId,
            Duration,
            StatusCode,
            SpanAttributes['ctxpipe.mcp.connection.key'] AS ConnectionKey,
            SpanAttributes['ctxpipe.mcp.call.id'] AS CallId,
            SpanAttributes['ctxpipe.mcp.tool'] AS Tool,
            SpanAttributes['ctxpipe.mcp.client.name'] AS ClientName,
            SpanAttributes['ctxpipe.mcp.org.slug_hash'] AS OrgSlugHash,
            SpanAttributes['ctxpipe.mcp.correlation.source'] AS CorrelationSource,
            SpanAttributes['ctxpipe.mcp.conversation.id'] AS ClientConversationId,
            SpanAttributes['ctxpipe.mcp.turn.id'] AS ClientTurnId,
            lagInFrame(toNullable(Timestamp)) OVER calls AS PreviousAt
        FROM otel.otel_traces
        WHERE SpanName LIKE 'mcp.tool %'
            AND SpanAttributes['ctxpipe.mcp.connection.key'] != ''
            AND Timestamp >= {from:DateTime64(9)}
            AND Timestamp < {to:DateTime64(9)}
        WINDOW calls AS (
            PARTITION BY DeploymentEnvironment, ConnectionKey
            ORDER BY Timestamp, CallId
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
    )
    WINDOW calls AS (
        PARTITION BY DeploymentEnvironment, ConnectionKey
        ORDER BY Timestamp, CallId
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
);
