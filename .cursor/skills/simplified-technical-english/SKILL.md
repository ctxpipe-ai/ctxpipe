---
name: simplified-technical-english
description: Simplified Technical English (ASD-STE100) for explanations. Use when you write or edit markdown, comments, docs, ADRs, commit messages, pull request text, changesets, or other retained text, and when you reply to the user.
---

# Simplified Technical English

The binding rules are in [`.cursor/rules/simplified-technical-english.mdc`](../../rules/simplified-technical-english.mdc). This skill repeats those rules and shows how to rewrite a sentence. When you change a rule, change the rule file and this skill in the same commit.

ASD-STE100 is Simplified Technical English, Issue 9 (2025). The dictionary is licensed. Do not copy the dictionary into the repo.

## When you write

1. Read the rule file if it is not already in your context.
2. Write the new explanation to the level below.
3. Run the check at the end of this skill. The check passes when each new sentence meets the level you used.

## Two levels

**Full standard.** Use this level for text that you keep:

- Markdown, including skills, ADRs, and docs
- A code comment that explains
- A commit message
- Pull request text
- A changeset
- Other retained text

**About 80%.** Use this level for a reply to the user. The sentence rules stay at full strength. You may relax at most one sentence in five. A relaxed sentence may use a common word, a contraction, a phrasal verb, an "-ing" form, or a warmer tone. A procedure step stays at full strength.

When you edit a file, write each new sentence to the standard. Change an old sentence only when you edit it for another reason.

Keep code, identifiers, commands, types, and quotes as they are. Product UI copy in `apps/ui` keeps UK spelling from `apps/ui/DESIGN.md`.

## Rules

### Words

- Use one word for one meaning. Use that same word each time you mean that thing.
- Use American spelling. Product UI copy is the exception (UK spelling).
- Use the technical name for a code name, a product name, or a term in `.ai/memory/glossary.md`. At the first use in a document, add a short definition.
- Use a word as one part of speech. Keep a noun as a noun.
- Use a plain word that a new reader can understand. Skip slang. Use the same word, not a synonym, when you repeat a meaning.

### Nouns

- A noun group has at most three words. When you need more words, use "of", "for", "in", or "on".
- Put "a", "an", "the", "this", or "these" before a noun when you mean one specific thing.

### Verbs

- Use the active voice. The subject does the action.
- For a procedure, start the sentence with a command verb.
- Use the simple present, the simple past, or the simple future.
- Use an "-ing" word only inside a technical name.
- In a description, use the passive voice only when you do not know the actor.

### Sentences

- Put one topic in each sentence.
- A procedure sentence has at most 20 words.
- A description sentence has at most 25 words.
- Write each word that the reader needs. Write "do not" in full. Do the same for other short forms.
- Write two sentences in place of a semicolon.
- Use a vertical list for many items or many actions. The line before the colon follows the word limit. Each item follows the same limit.

### Paragraphs

- Put one topic in each paragraph. Start the paragraph with that topic.
- A paragraph has at most six sentences.

### Safety text

- Start with "WARNING" when a person can be injured.
- Start with "CAUTION" when only equipment can be damaged.
- Then write the command. Then write the result if the reader does not follow the command.

## Examples

Each example keeps the meaning. The second text is the full standard.

**Procedure.** The reader must migrate the database before the server starts.

> Migrate the database. Then start the server. The server reads the new schema.

**Description.** One module ingests repository content.

> This module ingests the content of the repository.

**Noun group.** The query belongs to the worker supervisor.

> Run the query for the worker supervisor.

**Comment.** A dropped connection must not stop the worker.

> Connect again after a dropped connection. A dropped connection must not stop the worker.

**Safety.**

> WARNING: Stop the deploy when the health check fails. The service can stop if you continue.

**Reply at about 80%.** One sentence uses a contraction. The step stays in the full standard.

> The migrate command failed because Postgres isn't running. Start the database. Then run the command again.

## Check

The work is done when all of these are true:

- Each new procedure sentence has at most 20 words.
- Each new description sentence has at most 25 words.
- Each new sentence has one topic, an actor, and the active voice (or a command).
- Each noun group has at most three words.
- In a reply to the user, relaxed sentences are not more than one in five.
- You did not copy the STE dictionary into the repo.
