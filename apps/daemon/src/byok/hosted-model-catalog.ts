export interface HostedModelCatalog {
  id: string;
  label: string;
}

/**
 * Hosted deployments can pin the public chat catalog to one model id while
 * showing a different label. Both env vars must be non-empty; otherwise the
 * local/dev picker stays unrestricted.
 */
export function readHostedModelCatalog(
  env: NodeJS.ProcessEnv = process.env,
): HostedModelCatalog | null {
  const id = env.OD_HOSTED_MODEL_ID?.trim() ?? '';
  const label = env.OD_HOSTED_MODEL_LABEL?.trim() ?? '';
  if (!id || !label) return null;
  return { id, label };
}
