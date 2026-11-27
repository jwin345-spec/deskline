import { NextResponse } from 'next/server';
import { assertSameOrigin, requireApiSession, tenantContext } from '@/server/auth/current';
import { getContainer } from '@/server/container';
import { DomainError } from '@/server/domain/errors';
import { suggestReply } from '@/server/services/ai-reply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Returns an AI draft for the agent to edit. It never sends anything. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await assertSameOrigin();
    const session = await requireApiSession();
    const { id } = await params;
    const { db, drafter } = await getContainer();
    const result = await suggestReply(db, tenantContext(session), drafter, {
      ticketId: id,
      workspaceName: session.workspaceName,
    });
    if (result.kind === 'refused') {
      return NextResponse.json(
        { error: 'ai_refused', detail: 'The model declined to draft a reply for this thread.' },
        { status: 422 },
      );
    }
    return NextResponse.json({
      draft: result.text,
      truncated: result.truncated,
      model: result.model,
    });
  } catch (error) {
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: error.code, detail: error.message },
        { status: error.status },
      );
    }
    console.error('suggest-reply failed', error);
    return NextResponse.json(
      { error: 'internal', detail: 'Something went wrong' },
      { status: 500 },
    );
  }
}
