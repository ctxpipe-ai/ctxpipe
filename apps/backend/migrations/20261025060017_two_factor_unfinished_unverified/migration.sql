-- The new `verified` column defaults to true. A factor row of a user who did
-- not finish the setup (two-factor not enabled) must read as unverified, so
-- that a later enable and TOTP confirm turns two-factor on.
UPDATE "two_factors" t SET "verified" = false FROM "users" u WHERE t."user_id" = u."id" AND u."two_factor_enabled" IS NOT TRUE;
