import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const runStatusEnum = pgEnum("run_status", [
  "queued",
  "running",
  "pass",
  "fail",
  "cancelled",
]);

export const sourceTypeEnum = pgEnum("source_type", ["bundle", "remote", "relay"]);

export const scenarioStatusEnum = pgEnum("scenario_status", ["pass", "fail", "completed", "error"]);

export const testTypeEnum = pgEnum("test_type", ["audio", "conversation", "load_test", "red_team"]);
export const platformConnectionStatusEnum = pgEnum("platform_connection_status", ["active", "disabled", "invalid"]);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    access_token_id: uuid("access_token_id")
      .notNull()
      .references(() => accessTokens.id),
    user_id: text("user_id").notNull(),
    status: runStatusEnum("status").notNull().default("queued"),
    source_type: sourceTypeEnum("source_type").notNull(),
    bundle_key: text("bundle_key"),
    bundle_hash: text("bundle_hash"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    aggregate_json: jsonb("aggregate_json"),
    test_spec_json: jsonb("test_spec_json"),
    error_text: text("error_text"),
    // Stores a SHA-256 of the provided idempotency key.
    idempotency_key: text("idempotency_key"),
    relay_token: text("relay_token"),
  },
  (table) => ({
    runsUserScopedIdempotency: uniqueIndex("runs_user_id_idempotency_key_unique")
      .on(table.user_id, table.idempotency_key)
      .where(sql`${table.idempotency_key} IS NOT NULL`),
  }),
);

export const scenarioResults = pgTable("scenario_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  run_id: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: scenarioStatusEnum("status").notNull(),
  test_type: testTypeEnum("test_type"),
  metrics_json: jsonb("metrics_json").notNull(),
  trace_json: jsonb("trace_json").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const baselines = pgTable("baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  run_id: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  user_id: text("user_id").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const depImageStatusEnum = pgEnum("dep_image_status", [
  "building",
  "ready",
  "failed",
]);

export const depImages = pgTable("dep_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  lockfile_hash: text("lockfile_hash").notNull().unique(),
  image_ref: text("image_ref").notNull(),
  base_image_ref: text("base_image_ref"),
  status: depImageStatusEnum("status").notNull().default("building"),
  builder_machine_id: text("builder_machine_id"),
  error_text: text("error_text"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  ready_at: timestamp("ready_at", { withTimezone: true }),
});

export const accessTokens = pgTable("access_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  user_id: text("user_id").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  name: text("name").notNull(),
  prefix: text("prefix").notNull().default(""),
  is_anonymous: boolean("is_anonymous").notNull().default(false),
  run_limit: integer("run_limit"),
  revoked_at: timestamp("revoked_at", { withTimezone: true }),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const platformConnections = pgTable(
  "platform_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: text("user_id").notNull(),
    provider: text("provider").notNull(),
    identity_key: text("identity_key").notNull(),
    resource_label: text("resource_label").notNull(),
    config_json: jsonb("config_json").notNull(),
    secrets_encrypted: jsonb("secrets_encrypted").notNull(),
    resolved_hash: text("resolved_hash").notNull(),
    version: integer("version").notNull().default(1),
    status: platformConnectionStatusEnum("status").notNull().default("active"),
    last_verified_at: timestamp("last_verified_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    platformConnectionsUserIdentityUnique: uniqueIndex("platform_connections_user_provider_identity_unique")
      .on(table.user_id, table.provider, table.identity_key),
    platformConnectionsUserUpdatedIdx: index("platform_connections_user_updated_idx")
      .on(table.user_id, table.updated_at),
  }),
);

export const artifacts = pgTable("artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  run_id: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  content_type: text("content_type").notNull(),
  byte_size: bigint("byte_size", { mode: "number" }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const deviceSessions = pgTable("device_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  session_id: text("session_id").notNull().unique(),
  user_code: text("user_code").notNull().unique(),
  user_id: text("user_id"),
  access_token_id: uuid("access_token_id").references(() => accessTokens.id),
  raw_access_token: text("raw_access_token"),
  expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  consumed_at: timestamp("consumed_at", { withTimezone: true }),
});

export const runEvents = pgTable("run_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  run_id: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  event_type: text("event_type").notNull(),
  message: text("message").notNull(),
  metadata_json: jsonb("metadata_json"),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
