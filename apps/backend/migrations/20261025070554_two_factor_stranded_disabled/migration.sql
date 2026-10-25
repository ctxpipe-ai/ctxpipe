-- Before the fix, the enable call failed after it set two-factor on but before
-- it stored a factor row. Such a user cannot finish a sign-in. Turn two-factor
-- off for each user that has it on and has no factor row.
UPDATE "users" u SET "two_factor_enabled" = false WHERE u."two_factor_enabled" = true AND NOT EXISTS (SELECT 1 FROM "two_factors" t WHERE t."user_id" = u."id");
