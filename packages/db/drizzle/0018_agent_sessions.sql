ALTER TYPE "public"."source_type" ADD VALUE 'session';
--> statement-breakpoint
CREATE TYPE "public"."agent_session_status" AS ENUM('connecting', 'active', 'closed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"access_token_id" uuid NOT NULL,
	"relay_token" text NOT NULL,
	"status" "agent_session_status" DEFAULT 'connecting' NOT NULL,
	"config_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_session_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_access_token_id_access_tokens_id_fk" FOREIGN KEY ("access_token_id") REFERENCES "public"."access_tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
