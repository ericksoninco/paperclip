ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "append_policy" text DEFAULT 'owner_only' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'issues_append_policy_check'
  ) THEN
    ALTER TABLE "issues"
      ADD CONSTRAINT "issues_append_policy_check"
      CHECK ("append_policy" IN ('owner_only', 'comment_append_open'));
  END IF;
END $$;
