DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'retrieval_objects'
      AND column_name = 'type'
  ) THEN
    ALTER TABLE "retrieval_objects" RENAME COLUMN "type" TO "kind";
  END IF;
END $$;