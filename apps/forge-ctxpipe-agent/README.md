# Forge ctxpipe Atlassian Connector

This project contains the Forge app used by ctxpipe to connect Atlassian/Confluence organizations.
It keeps a small Confluence global settings page and forwards Forge lifecycle events to a remote backend webhook.

See [developer.atlassian.com/platform/forge/](https://developer.atlassian.com/platform/forge) for documentation and tutorials explaining Forge.

## Requirements

See [Set up Forge](https://developer.atlassian.com/platform/forge/set-up-forge/) for instructions to get set up.

## Quick start

- Modify your app frontend by editing the `src/frontend/index.jsx` file.

- Modify your app backend by editing the `src/resolvers/index.js` file to define resolver functions. See [Forge resolvers](https://developer.atlassian.com/platform/forge/runtime-reference/custom-ui-resolver/) for documentation on resolver functions.

- Build and deploy your app by running:
```
forge deploy
```

- Install your app in an Atlassian site by running:
```
forge install
```

- Develop your app by running `forge tunnel` to proxy invocations locally:
```
forge tunnel
```

### Remote event delivery

The manifest configures Forge `trigger` modules with `endpoint`/`remotes` so lifecycle events are sent to:

- `POST /api/v1/webhook/atlassian/forge` on the configured `ctxpipe-backend` remote.

Make sure `remotes[ctxpipe-backend].baseUrl` points to your backend origin before deploying.

### Notes
- Use the `forge deploy` command when you want to persist code changes.
- Use the `forge install` command when you want to install the app on a new site.
- Once the app is installed on a site, the site picks up the new app changes you deploy without needing to rerun the install command.

