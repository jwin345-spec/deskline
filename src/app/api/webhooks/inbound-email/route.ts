import { NextResponse } from 'next/server';
import { getContainer } from '@/server/container';
import {
  findWorkspaceByInboundAddress,
  inboundEmailSchema,
  processInboundEmail,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from '@/server/services/inbound-email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

function problem(status: number, code: string, detail: string) {
  return NextResponse.json({ error: code, detail }, { status });
}

/**
 * Inbound email webhook (the shape an email provider's "parse" hook would
 * post). Authenticated by HMAC, not cookies, so it is exempt from CSRF checks.
 * Order matters: size limit, routing, signature, then validation and writes.
 */
export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > MAX_BODY_BYTES) return problem(413, 'payload_too_large', 'Body exceeds 256 KiB');
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return problem(413, 'payload_too_large', 'Body exceeds 256 KiB');
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return problem(400, 'invalid_json', 'Body must be JSON');
  }
  const to =
    typeof json === 'object' && json !== null && 'to' in json && typeof json.to === 'string'
      ? json.to
      : null;
  if (!to) return problem(400, 'invalid_payload', 'Missing "to" address');

  const { db, deps } = await getContainer();
  const workspace = await findWorkspaceByInboundAddress(db, to);
  // Unknown address and bad signature look the same to the caller.
  const valid =
    workspace !== null &&
    verifySignature({
      secret: workspace.webhookSecret,
      rawBody,
      timestamp: request.headers.get(TIMESTAMP_HEADER),
      signature: request.headers.get(SIGNATURE_HEADER),
      now: deps.now(),
    });
  if (!workspace || !valid)
    return problem(401, 'invalid_signature', 'Signature verification failed');

  const parsed = inboundEmailSchema.safeParse(json);
  if (!parsed.success) {
    return problem(
      422,
      'invalid_payload',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const result = await processInboundEmail(db, deps, workspace.id, parsed.data);
  return NextResponse.json(result, { status: result.outcome === 'duplicate' ? 200 : 201 });
}
