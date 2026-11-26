/** Shared helpers for the PostgreSQL (Drizzle) data layer. */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replacement for mongoose `Types.ObjectId.isValid`. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function pgErrorCode(error: unknown): string | undefined {
  // Drizzle wraps driver errors in DrizzleQueryError with the original error in `cause`.
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
  }
  return undefined;
}

/** True for a unique-constraint violation (Postgres 23505; replaces Mongo duplicate key 11000). */
export function isDuplicateKey(error: unknown): boolean {
  return pgErrorCode(error) === "23505";
}

/** True for a foreign-key violation (Postgres 23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  return pgErrorCode(error) === "23503";
}

/** Escapes `%`, `_` and `\` for use inside ILIKE patterns (replaces Mongo `$regex` searches). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Adds a Mongo-style `_id` alias next to `id` for API responses that used to return raw Mongoose
 * documents, so the client keeps working unchanged.
 */
export function withMongoId<T extends { id: string }>(row: T): T & { _id: string } {
  return { _id: row.id, ...row };
}

/** First row of a `.returning()` / select result, or null. */
export function first<T>(rows: T[]): T | null {
  return rows[0] ?? null;
}
