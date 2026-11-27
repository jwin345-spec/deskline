import { sql } from 'kysely';
import { NextResponse } from 'next/server';
import { getContainer } from '@/server/container';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Readiness: the database answers a query. */
export async function GET(): Promise<Response> {
  try {
    const { db } = await getContainer();
    await sql`select 1`.execute(db);
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('health check failed', error);
    return NextResponse.json({ status: 'unavailable' }, { status: 503 });
  }
}
