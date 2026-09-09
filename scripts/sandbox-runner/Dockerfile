FROM docker:27-dind@sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce
RUN apk add --no-cache btrfs-progs util-linux
COPY entrypoint.sh /usr/local/bin/ctxpipe-sandbox-runner
RUN chmod 755 /usr/local/bin/ctxpipe-sandbox-runner
VOLUME /var/lib/ctxpipe-sandbox-storage
ENTRYPOINT ["ctxpipe-sandbox-runner"]
