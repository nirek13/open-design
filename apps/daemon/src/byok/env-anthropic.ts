import { readHostedModelCatalog } from './hosted-model-catalog.js';

export const ENV_ANTHROPIC_BYOK_PROFILE_ID = 'byok-env-anthropic';
export const ENV_ANTHROPIC_BYOK_LABEL = 'Default Anthropic key';
export const ENV_ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ENV_ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

/** Host catalog, then `OD_DEFAULT_ANTHROPIC_MODEL`, then the local default. */
export function readEnvAnthropicDefaultModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hosted = readHostedModelCatalog(env);
  if (hosted) return hosted.id;
  const override = env.OD_DEFAULT_ANTHROPIC_MODEL?.trim();
  return override || ENV_ANTHROPIC_DEFAULT_MODEL;
}

const ENV_ANTHROPIC_KEY_NAMES = [
  'OD_DEFAULT_ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

export function readEnvAnthropicApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of ENV_ANTHROPIC_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function isOfficialAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
}
