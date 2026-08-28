import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Boot-time environment validation. Exits non-zero on any missing REQUIRED key
 * (11_API_KEYS §11.7, 02_TRD SEC-9). Provider credentials are optional at the type level;
 * a runtime check warns (does not exit) on an empty provider chain.
 *
 * Secrets come from the environment only. In development we additionally read the
 * git-ignored repo-root `.env`; a real environment variable always wins over the file, so
 * containers and CI are unaffected (02_TRD SEC-9, 11_API_KEYS KEY-3).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(HERE, '../../../.env'), override: false, quiet: true });
const EnvSchema = z.object({
  // ── core ──────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().url().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // ── datastores ───────────────────────────────────────────────────
  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().min(1),
  REDIS_URL: z.string().min(1),

  // ── object storage (S3-compatible) ───────────────────────────────
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ── auth ─────────────────────────────────────────────────────────
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  COOKIE_DOMAIN: z.string().default('localhost'),

  // ── internal services ────────────────────────────────────────────
  ML_SERVICE_URL: z.string().url(),
  ML_SERVICE_TOKEN: z.string().min(1),
  TITILER_URL: z.string().url(),

  // ── satellite providers ──────────────────────────────────────────
  CDSE_CLIENT_ID: z.string().optional(),
  CDSE_CLIENT_SECRET: z.string().optional(),
  CDSE_S3_ACCESS_KEY: z.string().optional(),
  CDSE_S3_SECRET_KEY: z.string().optional(),
  PLANETARY_COMPUTER_SUBSCRIPTION_KEY: z.string().optional(),
  EARTHDATA_USERNAME: z.string().optional(),
  EARTHDATA_PASSWORD: z.string().optional(),
  USGS_M2M_USERNAME: z.string().optional(),
  USGS_M2M_TOKEN: z.string().optional(),

  // ── environmental data ───────────────────────────────────────────
  CMEMS_USERNAME: z.string().optional(),
  CMEMS_PASSWORD: z.string().optional(),
  CDSAPI_URL: z.string().url().optional(),
  CDSAPI_KEY: z.string().optional(),
  NOAA_GFS_BASE_URL: z.string().url().default('https://nomads.ncep.noaa.gov'),

  // ── AIS providers ────────────────────────────────────────────────
  GFW_API_TOKEN: z.string().optional(),
  AISSTREAM_API_KEY: z.string().optional(),
  MARINE_CADASTRE_BASE_URL: z.string().url().optional(),
  DMA_AIS_BASE_URL: z.string().url().optional(),

  // ── map / tiles ──────────────────────────────────────────────────
  MAPTILER_KEY: z.string().optional(),
  MAPBOX_TOKEN: z.string().optional(),

  // ── notifications / ops ──────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    console.error(
      '❌ Invalid environment configuration:\n' +
        parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'),
    );
    process.exit(1);
  }
  cached = parsed.data;
  return cached;
}

export const env: Env = loadEnv();

/**
 * A provider chain with no configured credentials is a configuration error we want to
 * discover at boot, not when an analyst clicks "search". We warn loudly rather than
 * exiting — a partially-configured system is still useful for development.
 * A missing key degrades CAPABILITY, never DATA INTEGRITY (11_API_KEYS §11.7).
 */
export function assertProviderChains(logger: { warn: (obj: unknown, msg?: string) => void }): void {
  const checks = [
    {
      chain: 'SATELLITE',
      ok: Boolean(
        env.CDSE_CLIENT_ID || env.EARTHDATA_USERNAME || env.PLANETARY_COMPUTER_SUBSCRIPTION_KEY,
      ),
    },
    { chain: 'OCEAN_CURRENTS', ok: Boolean(env.CMEMS_USERNAME) },
    { chain: 'WIND', ok: Boolean(env.CDSAPI_KEY) },
    { chain: 'AIS', ok: true }, // bulk archives need no key
  ];
  for (const c of checks) {
    if (!c.ok) {
      logger.warn(
        { chain: c.chain },
        `No credential configured for the ${c.chain} provider chain. Requests will fall back ` +
          `to keyless providers, and will return UNAVAILABLE if those also fail. ` +
          `This will NOT produce placeholder data.`,
      );
    }
  }
}
