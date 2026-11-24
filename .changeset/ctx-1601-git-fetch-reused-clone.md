---
"@ctxpipe/aws-cdk": patch
---

A Workspace step that reads commits from the Git host now downloads only the objects that changed since an earlier read of the same repository. Before, each step downloaded the full tree of the commit again. A large repository on a slow Git host then stopped at the 60 s limit 3 times in each step, and the PR mirror and the sources sync of that repository failed. Now a fetch stops only when the Git host sends no data for 60 s, or after 10 min. After such a stop, the steps of that repository fail at once for 5 min with a clear error, and do not hold a worker slot.
