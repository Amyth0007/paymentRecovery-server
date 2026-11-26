import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Database = PostgresJsDatabase<typeof schema>;
/** A transaction handle; accepts the same query API as `db`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Use in helpers that should work both inside and outside a transaction. */
export type DbOrTx = Database | Transaction;

export type DatabaseOptions = {
  /** Pooled connection string. On Supabase use the transaction pooler (port 6543). */
  url: string;
  /** Direct/session connection used only for migrations (Supabase port 5432). Falls back to `url`. */
  migrationUrl?: string;
  /** Max connections this process opens to the pooler. */
  poolMax?: number;
  /** Seconds before an idle pooled connection is closed. */
  idleTimeoutSeconds?: number;
  ssl?: boolean;
  /** Apply pending SQL migrations from ./drizzle at startup (default true). */
  runMigrations?: boolean;
};

let client: Sql | null = null;
let instance: Database | null = null;
let healthy = false;

function createClient(url: string, options: DatabaseOptions, max: number) {
  return postgres(url, {
    max,
    idle_timeout: options.idleTimeoutSeconds ?? 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    // Supabase's transaction pooler (Supavisor/PgBouncer, port 6543) does not support prepared statements.
    prepare: false,
    ssl: options.ssl === false ? false : url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
    onnotice: () => undefined,
  });
}

/**
 * Opens the shared connection pool, applies pending migrations, and verifies connectivity.
 * Must run before the first query (server.ts does this at startup).
 */
export async function connectDatabase(options: DatabaseOptions): Promise<void> {
  if (options.runMigrations !== false) {
    // Migrations use a single short-lived connection, ideally direct (not through the transaction pooler).
    const migrationClient = createClient(options.migrationUrl || options.url, options, 1);
    try {
      await migrate(drizzle(migrationClient, { casing: "snake_case" }), {
        migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
      });
    } finally {
      await migrationClient.end({ timeout: 5 });
    }
  }
  client = createClient(options.url, options, options.poolMax ?? 10);
  instance = drizzle(client, { schema, casing: "snake_case" });
  await client`select 1`;
  healthy = true;
}

/** Shared Drizzle instance. Throws if used before connectDatabase(). */
export const db: Database = new Proxy({} as Database, {
  get(_target, property) {
    if (!instance) throw new Error("Database used before connectDatabase() was called");
    const value = (instance as unknown as Record<PropertyKey, unknown>)[property];
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(instance) : value;
  },
});

export function isDatabaseConnected(): boolean {
  return healthy && client !== null;
}

export async function disconnectDatabase(): Promise<void> {
  healthy = false;
  await client?.end({ timeout: 5 });
  client = null;
  instance = null;
}
