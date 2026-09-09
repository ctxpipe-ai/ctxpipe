FROM node@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d

# Build-time tools only; a conversation never installs its harness as root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git gh findutils \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global opencode-ai@1.18.18 \
    && npm cache clean --force \
    && mkdir -p /workspace /home/node/.config /home/node/.local/share /home/node/.local/state /home/node/.cache \
    && chown -R 1000:1000 /workspace /home/node

COPY git-credential.mjs /usr/local/bin/ctxpipe-git-credential
RUN chmod 755 /usr/local/bin/ctxpipe-git-credential \
    && ln -s /usr/local/bin/ctxpipe-git-credential /usr/local/bin/gh \
    && git config --system credential.helper /usr/local/bin/ctxpipe-git-credential \
    && git config --system credential.useHttpPath true

ENV GIT_TERMINAL_PROMPT=0
ENV HOME=/home/node
USER 1000:1000
WORKDIR /workspace
CMD ["sh", "-c", "tail -f /dev/null"]
