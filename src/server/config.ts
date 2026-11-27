import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const configSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1)
    .refine((v) => v.startsWith('pglite:') || /^postgres(ql)?:\/\//.test(v), {
      message: 'DATABASE_URL must be pglite:<dir>, pglite:memory or postgres://...',
    })
    .default('pglite:./.data/deskline'),
  ANTHROPIC_API_KEY: z.string().optional(),
  SLA_WORKER_ENABLED: booleanString.default(true),
  SLA_WORKER_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
  COOKIE_SECURE: booleanString.default(false),
  /** Apply pending migrations when the server boots (default for local/PGlite). */
  MIGRATE_ON_START: booleanString.optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
  }
  return result.data;
}
