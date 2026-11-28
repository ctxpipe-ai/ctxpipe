Previously, `check_time_input` checked numeric input with `Number.isNaN(Number(input_value))`. However, JavaScript's `Number()` accepts scientific notation (e.g. `"1e2"` is parsed as `100`) and hexadecimal strings (e.g. `"0x10"` is parsed as `16`), whereas `Number.parseInt` subsequently truncates at the first non-digit character (returning `1` for `"1e2"` and `0` for `"0x10"`).

Custom time inputs across Zulip modal dialogs and settings (invitations, message retention, message editing time limits) are intended to accept standard decimal numbers. As noted in issue discussion by maintainers, inputs with scientific or hexadecimal notation should be rejected as invalid (`NaN`), rather than silently parsed into unexpected numbers.

Which files in the organization's repositories must change to fix this?

Write your answer to `/app/answer.md`. End it with a section `## Files` that lists each file that the change needs, one on each line, as `<repository>:<path>` (the name of the repository and the path from its root). If the sources do not hold the answer, write `NO ANSWER` as the first line, and then say what is missing.
