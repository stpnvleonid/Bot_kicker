import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, 'BOT_TOKEN is required'),
  DATABASE_URL: z.string().min(1).default('file:./data/bot.sqlite'),
  ENCRYPTION_KEY: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  PLANNER_SHEET_ID: z.string().optional(),
  PLANNER_SHEET_RANGE: z.string().optional().default('Sheet1!A:D'),
  TZ: z.string().optional().default('UTC'),
  DEBUG: z.string().optional().transform((v) => v === '1' || v?.toLowerCase() === 'true'),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | null = null;

export function getConfig(): Config {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const msg = parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw new Error(`Config validation failed: ${msg}`);
    }
    cached = parsed.data;
  }
  return cached;
}
