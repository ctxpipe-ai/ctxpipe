When uwsgi's `harakiri` kills a worker, PostgreSQL keeps running that worker's query to completion; it only notices the client is gone when it tries to send results, logging `could not send data to client: Broken pipe`.

A query with a bad plan can run for minutes after its request has failed, and each client retry starts another copy of it. In a recent production incident, six concurrent copies of a mark-topic-as-read batch query each ran for nearly five minutes, long after their requests had been killed at 55 seconds.

Which files in the zulip/zulip repository must change to fix this?

Write your answer to `/app/answer.md`. End it with a section `## Files` that lists each file that the change needs, one on each line, as `<repository>:<path>` (the name of the repository and the path from its root). If the sources do not hold the answer, write `NO ANSWER` as the first line, and then say what is missing.
