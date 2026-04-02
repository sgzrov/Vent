CREATE TYPE "platform_connection_status" AS ENUM ('active', 'disabled', 'invalid');
CREATE TABLE "platform_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "provider" text NOT NULL,
  "identity_key" text NOT NULL,
  "resource_label" text NOT NULL,
  "config_json" jsonb NOT NULL,
  "secrets_encrypted" jsonb NOT NULL,
  "resolved_hash" text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "status" "platform_connection_status" DEFAULT 'active' NOT NULL,
  "last_verified_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "platform_connections_user_provider_identity_unique" ON "platform_connections" USING btree ("user_id","provider","identity_key");
CREATE INDEX "platform_connections_user_updated_idx" ON "platform_connections" USING btree ("user_id","updated_at");
