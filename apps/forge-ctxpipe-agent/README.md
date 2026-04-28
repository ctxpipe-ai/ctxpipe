# Atalssian ctxpipe Forge App

Atlassian Forge is a development platform which allows external systems like ctxpipe to integrate with Atlassian. For ctxpipe, we are interested in ingesting Confluence spaces/pages as well as keeping them up-to-date with webhooks. Due to this, [Forge Remote](https://developer.atlassian.com/platform/forge/remote/) is the best option to use to integrate with Atlassian as Forge will send us all the information we need while maintaining all our logic in ctxpipe

See [developer.atlassian.com/platform/forge/](https://developer.atlassian.com/platform/forge) for documentation and tutorials explaining Forge.

## Our set-up
As we are using Forge Remote, `manifest.yml` is main thing we need in our set up. It configures:
- [Trigger](https://developer.atlassian.com/platform/forge/manifest-reference/modules/trigger/) that we want to listen to
- [Scheduled trigger](https://developer.atlassian.com/platform/forge/remote/scheduled-triggers/) so that we can refresh our token as we don't have a way of minting a new token on demand like Github App
- Scopes that our Forge App has access to
- And most importantly, the REMOTE_URL which is the URL of our backend that will receive requests from Forge
Other than that, all logic is handled within ctxpipe - Forge only forwards events to us.


## For self-hosting option:
As Forge app requires a whitelist of remotes that it can send requests to, customers using self-host option won't be able to install our Forge App. They are required to set up one themselves. We will look at simplifying the set up flow and testing it out but here are the steps:

- Create a Forge App on [Atlassian Developer](https://developer.atlassian.com/)
- Copy our manifest.yml into the repo where they manage the infrastructure for their ctxpipe instance
- Update `app.id` to their newly created Forge App
- Update `REMOTE_BASE_URL` to their ctxpipe's URL
- Then run `pnpm dlx forge deploy --environment production`
- Set these env variables
    - For backend: ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET - you will be able to get this when setting up an [Atlassian OAuth App](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/). We need this OAuth app also to verify that the user who installed the Forge App has access to that Confluence instance



- get token at https://id.atlassian.com/manage-profile/security/api-tokens
- `FORGE_EMAIL=<email> FORGE_API_TOKEN=<token> forge create` to create an app
- from it's manifest copy app.id, put it into copy of our forge-ctxpipe-agent
- `FORGE_EMAIL=<email> FORGE_API_TOKEN=<token> pnpm deploy:prod`
- click on link "To install on any other site, generate an installation link in the developer console and share it with the site admin: https://developer.atlassian.com/console/myapps/ ..." in the output