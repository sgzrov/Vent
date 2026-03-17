CREATE TABLE IF NOT EXISTS "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"api_key_id" uuid,
	"raw_api_key" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "device_sessions_session_id_unique" UNIQUE("session_id"),
	CONSTRAINT "device_sessions_user_code_unique" UNIQUE("user_code")
);

DO $$ BEGIN
	ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
