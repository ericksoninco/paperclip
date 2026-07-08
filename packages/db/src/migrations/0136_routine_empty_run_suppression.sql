ALTER TABLE "routines"
  ADD COLUMN IF NOT EXISTS "suppress_empty_run_issues" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "routine_runs"
  ADD COLUMN IF NOT EXISTS "execution_outcome" text;
