/**
 * Boots the container (database, migrations for PGlite, SLA worker) when the
 * Node.js server starts, instead of on the first request, so SLA checks run
 * even while nobody has the app open.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { getContainer } = await import('./server/container');
  await getContainer();
}
