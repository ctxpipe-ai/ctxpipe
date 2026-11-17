---
"@ctxpipe/aws-cdk": patch
---

UI fixes from the review of a sample of the stories:

- Quiet buttons, and the email and organization under the names in the side nav, are easier to read.
- A toast that confirms an action or reports an error has a dark surface, with the color only on its icon.
- On a phone, the page content uses the full width under the menu button.
- The page loading skeleton shows its lines one under the other, and its rows fade. The weekday letters of the date range calendar use the regular weight.
- Workspaces: a destination row has a chevron; a push entry says when GitHub did not open the pull request; the submit button of the repository picker always shows; the graph card has Try again.
- Connectors: a connection whose status check failed says so and offers Retry; an OAuth error shows as an error alert with a title.
- Sources and upgrades: the Linear and Slack scope editors show a load error with Retry; the Add to Workspaces step shows each upgrade link one time; an upgrade item does not repeat its status, and a re-ingestion does not ask for a format upgrade that the Workspace already has.
- Home, chat, account and onboarding: a closed activity row in the chat has a chevron; the revoke and onboarding errors give the next step.
