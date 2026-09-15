import { prisma } from '../db.js';
import { isValidTimezone } from '../lib/availability.js';

/**
 * Loose application settings, kept in the Setting key/value table so a new
 * toggle never needs a migration.
 */

export const SETTING_KEYS = {
  timezone: 'school.timezone',
  generationPipeline: 'generation.pipeline',
} as const;

export type GenerationPipelineMode = 'single' | 'external_external';

export interface GenerationPipelineConfig {
  mode: GenerationPipelineMode;
  cheapCredentialId?: string | null;
  cacheSystemPrompt?: boolean;
  /** Override avg completion tokens per question; when null, adaptive from history is used. */
  tokensPerQuestion?: number | null;
}

const DEFAULT_PIPELINE: GenerationPipelineConfig = {
  mode: 'single',
  cheapCredentialId: null,
  cacheSystemPrompt: false,
  tokensPerQuestion: null,
};

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * The school's timezone, used to evaluate every daily availability window.
 *
 * Cached for a minute: it is read on every dashboard load and every attempt
 * start, and it changes perhaps once in the life of the system.
 */
let cache: { value: string; readAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSchoolTimezone(): Promise<string> {
  if (cache && Date.now() - cache.readAt < TTL_MS) return cache.value;

  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.timezone } }).catch(() => null);
  const stored = typeof row?.value === 'string' ? row.value : null;
  const value = stored && isValidTimezone(stored) ? stored : DEFAULT_TIMEZONE;

  cache = { value, readAt: Date.now() };
  return value;
}

export async function setSchoolTimezone(timezone: string): Promise<string> {
  if (!isValidTimezone(timezone)) {
    throw new Error(`"${timezone}" is not a recognised timezone. Use an IANA name such as Asia/Kolkata.`);
  }
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.timezone },
    update: { value: timezone },
    create: { key: SETTING_KEYS.timezone, value: timezone },
  });
  cache = { value: timezone, readAt: Date.now() };
  return timezone;
}

export async function getGenerationPipeline(): Promise<GenerationPipelineConfig> {
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEYS.generationPipeline } }).catch(() => null);
  if (!row || typeof row.value !== 'object' || row.value === null) return DEFAULT_PIPELINE;
  const v = row.value as Record<string, unknown>;
  // A stored 'external_local' (from before the local LLM was removed) falls
  // back to single rather than failing the run it was meant to speed up.
  const mode = v.mode === 'external_external' ? 'external_external' : DEFAULT_PIPELINE.mode;
  return {
    mode,
    cheapCredentialId: typeof v.cheapCredentialId === 'string' ? v.cheapCredentialId : null,
    cacheSystemPrompt: typeof v.cacheSystemPrompt === 'boolean' ? v.cacheSystemPrompt : false,
    tokensPerQuestion: typeof v.tokensPerQuestion === 'number' && v.tokensPerQuestion >= 200 && v.tokensPerQuestion <= 5000 ? v.tokensPerQuestion : null,
  };
}

export async function setGenerationPipeline(config: GenerationPipelineConfig): Promise<GenerationPipelineConfig> {
  const value = {
    mode: config.mode,
    cheapCredentialId: config.cheapCredentialId ?? null,
    cacheSystemPrompt: !!config.cacheSystemPrompt,
    tokensPerQuestion: typeof config.tokensPerQuestion === 'number' && config.tokensPerQuestion >= 200 && config.tokensPerQuestion <= 5000 ? config.tokensPerQuestion : null,
  };
  await prisma.setting.upsert({
    where: { key: SETTING_KEYS.generationPipeline },
    update: { value },
    create: { key: SETTING_KEYS.generationPipeline, value },
  });
  return value;
}

/** Drops the cache, so a restore or a direct edit is picked up promptly. */
export function invalidateSettingsCache() {
  cache = null;
}
