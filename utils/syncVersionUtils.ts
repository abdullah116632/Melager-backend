import { sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/**
 * Compare-and-set guard for an offline mutation replayed through a sync
 * endpoint.
 *
 * Drizzle writes a `timestamp` column through `Date.toISOString()`, so the
 * stored wall clock is UTC. A raw `Date` interpolated into a `sql` template
 * skips that mapping, and node-postgres then sends it in the server's local
 * zone instead. Casting to `timestamp without time zone` drops the offset, so
 * on any server that is not on UTC the two sides differ by exactly that
 * offset and the guard can never match. Bind the UTC text and cast it so both
 * sides describe the same wall clock regardless of the server timezone.
 */
export const updatedAtMatches = (column: PgColumn, value: Date): SQL =>
  sql`date_trunc('milliseconds', ${column}) = (${value.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
