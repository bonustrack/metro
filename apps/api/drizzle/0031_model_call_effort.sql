ALTER TABLE "model_calls" ADD COLUMN IF NOT EXISTS "effort" text CONSTRAINT "model_calls_effort_check" CHECK (char_length("effort") <= 32);
