import Resolver from '@forge/resolver';

const resolver = new Resolver();

resolver.define('getText', (req) => {
  return `ctxpipe Atlassian connector is active for site: ${req.context?.siteUrl ?? 'unknown'}`;
});

export const handler = resolver.getDefinitions();
