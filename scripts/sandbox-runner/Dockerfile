FROM docker:27-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce
RUN apk add --no-cache btrfs-progs socat util-linux
COPY entrypoint.sh /usr/local/bin/ctxpipe-sandbox-runner
COPY model-relay-entrypoint.sh /usr/local/bin/ctxpipe-sandbox-model-relay
RUN chmod 755 /usr/local/bin/ctxpipe-sandbox-runner /usr/local/bin/ctxpipe-sandbox-model-relay
VOLUME /var/lib/ctxpipe-sandbox-storage
# Keep a native tini as PID 1 and subreaper while the storage wrapper owns
# mount teardown. Docker's nested docker-init then has a real subreaper parent.
ENTRYPOINT ["docker-init", "-s", "--", "ctxpipe-sandbox-runner"]
