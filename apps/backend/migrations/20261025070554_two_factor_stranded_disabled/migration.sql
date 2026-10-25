-- The server config calls twoFactor() with default options, so an enable call
-- does not set two_factor_enabled until the user confirms a code. A user who
-- had two-factor on called enable again. Better Auth deleted the confirmed
-- factor row, and the insert of the new row then failed on the missing columns.
-- Such a user has two-factor on and no factor row, and cannot sign in
-- (TOTP_NOT_ENABLED). Turn two-factor off for each such user. The user can
-- sign in with a password and set up two-factor again. The lost factor cannot
-- be recovered.
UPDATE "users" u SET "two_factor_enabled" = false WHERE u."two_factor_enabled" = true AND NOT EXISTS (SELECT 1 FROM "two_factors" t WHERE t."user_id" = u."id");
