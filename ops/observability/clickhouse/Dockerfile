FROM clickhouse/clickhouse-server:26.8-alpine

COPY config.d/ /etc/clickhouse-server/config.d/
COPY users.d/ /etc/clickhouse-server/users.d/
COPY docker-entrypoint-initdb.d/ /docker-entrypoint-initdb.d/
