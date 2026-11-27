import { z } from 'zod';

const cursorSchema = z.object({
  /** Postgres text rendering of last_activity_at: exact to the microsecond. */
  t: z.string().min(1).max(64),
  i: z.uuid(),
});

export type Cursor = z.infer<typeof cursorSchema>;

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Returns null for anything malformed; callers treat that as "first page". */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const result = cursorSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
