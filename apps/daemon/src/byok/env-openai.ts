export const ENV_OPENAI_BYOK_PROFILE_ID = 'byok-env-openai';
export const ENV_OPENAI_BYOK_LABEL = 'Default OpenAI key';
export const ENV_OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const ENV_OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';

const ENV_OPENAI_KEY_NAMES = [
  'OD_DEFAULT_OPENAI_API_KEY',
  'OD_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;

export function readEnvOpenAiApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (const name of ENV_OPENAI_KEY_NAMES) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}
