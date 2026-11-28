Bug 1:

- Try to edit the options of a custom profile field with type select.
- Click the delete button on an option named `example_option`.
- Write `example_option1` in the new option textbox and you will notice that there is no confirmation dialog to delete the `example_option` value.

The above happens because `data-value` is changed by `read_select_field_data_from_form` when we have typed `example_option` in the new input box because it matches with an old value. Making any changes to that input box will not change the `data-value` and thus no delete confirmation dialog. `read_select_field_data_from_form` used to be called only before submit, but now it is called after any field is changed.

Bug 2:

- Add an option with the same value as an existing option.
- Click on save changes.
- The changes will be saved successfully without giving an error for duplicate choices.

Which files of the organization's repositories must change to fix this?

Write your answer to `/app/answer.md`. End it with a section `## Files` that lists each file that the change needs, one on each line, as `<repository>:<path>` (the name of the repository and the path from its root). If the sources do not hold the answer, write `NO ANSWER` as the first line, and then say what is missing.
