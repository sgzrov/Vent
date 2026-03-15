import fp from "fastify-plugin";
import { createDb, type Database } from "@vent/db";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}

export const dbPlugin = fp(async (app) => {
  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const db = createDb(connectionString);
  app.decorate("db", db);
});
