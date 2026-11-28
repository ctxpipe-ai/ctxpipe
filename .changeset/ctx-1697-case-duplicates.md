---
"@ctxpipe/aws-cdk": patch
---

fix: Knowledge search and `get_related`: two paths of a Workspace that differ only in case (for example `Billing.md` and `billing.md`) are one document. A read shows the copy that Git changed last, and a link to the other copy goes to it. Before, an agent got two answers for one file, and one of them was usually old. `read_file` and `list_files` give one answer too. On an org that uses the knowledge plane, the hourly tip check finds such paths, and ctxpipe repairs them: a direct commit keeps the lowercase path when the copies have the same content or ctxpipe owns the file, and a pull request merges two edited copies for a person to review.
