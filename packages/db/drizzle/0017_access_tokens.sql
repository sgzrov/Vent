ALTER TABLE "api_keys" RENAME TO "access_tokens";
ALTER TABLE "access_tokens" RENAME COLUMN "key_hash" TO "token_hash";
ALTER TABLE "runs" RENAME COLUMN "api_key_id" TO "access_token_id";
ALTER TABLE "device_sessions" RENAME COLUMN "api_key_id" TO "access_token_id";
ALTER TABLE "device_sessions" RENAME COLUMN "raw_api_key" TO "raw_access_token";

ALTER TABLE "access_tokens" RENAME CONSTRAINT "api_keys_pkey" TO "access_tokens_pkey";
ALTER TABLE "access_tokens" RENAME CONSTRAINT "api_keys_key_hash_unique" TO "access_tokens_token_hash_unique";
ALTER INDEX "idx_api_keys_user_id" RENAME TO "idx_access_tokens_user_id";
ALTER TABLE "runs" RENAME CONSTRAINT "runs_api_key_id_api_keys_id_fk" TO "runs_access_token_id_access_tokens_id_fk";
ALTER TABLE "device_sessions" RENAME CONSTRAINT "device_sessions_api_key_id_api_keys_id_fk" TO "device_sessions_access_token_id_access_tokens_id_fk";
