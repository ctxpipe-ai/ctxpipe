# Workspace chat image

Build with `docker build -t ctxpipe-chat-sandbox:local scripts/chat-sandbox`.
The image pins its Node base and OpenCode 1.18.18, includes Git and GitHub CLI,
and runs as UID/GID 1000 with a writable workspace and home. Resolve the built
image to an immutable digest or local image ID before using it in a native
sandbox definition, because that identity controls base-snapshot reuse.

This image is a Gate 4 prerequisite. It is not yet wired into production chat.
The native provider must also enforce the resource profile and egress policy;
the image alone does not establish those boundaries. Credentials are supplied
to individual threads at runtime, never baked into this image.
