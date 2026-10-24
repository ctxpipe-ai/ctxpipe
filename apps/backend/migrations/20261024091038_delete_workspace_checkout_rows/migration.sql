-- Workspace code reads use the published checkout of each repository, and the
-- codesearch cache reset of this release deletes the files of every checkout.
-- Delete the rows of the old Workspace checkout keys (`ws:<id>` and
-- `ws:<id>:<sha>`). A second run or an empty table deletes nothing.
DELETE FROM "repository_checkouts" WHERE "checkout_key" LIKE 'ws:%';
