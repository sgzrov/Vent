-- Indexes on (run_id) for hot-path lookups:
-- - scenario_results.run_id: GET /runs/:id reads all scenario rows for a run
-- - run_events.run_id + created_at: SSE history replay orders by created_at
-- Both tables grow per call; runs table is frequently joined against them.
CREATE INDEX IF NOT EXISTS "scenario_results_run_id_idx" ON "scenario_results" ("run_id");
CREATE INDEX IF NOT EXISTS "run_events_run_id_created_at_idx" ON "run_events" ("run_id", "created_at");
