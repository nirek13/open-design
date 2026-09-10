import { useMemo } from 'react';
import type { AuthContextResponse, HostedModelCatalog } from '@open-design/contracts';
import { useOptionalOrg } from '../org/OrgContext';

export type { HostedModelCatalog };

export function hostedModelCatalogFromAuth(
  auth: AuthContextResponse | null | undefined,
): HostedModelCatalog | null {
  const hosted = auth?.hostedModel;
  if (!hosted || typeof hosted.id !== 'string' || typeof hosted.label !== 'string') {
    return null;
  }
  const id = hosted.id.trim();
  const label = hosted.label.trim();
  if (!id || !label) return null;
  return { id, label };
}

export function useHostedModelCatalog(): HostedModelCatalog | null {
  const org = useOptionalOrg();
  const id = org?.auth?.hostedModel?.id;
  const label = org?.auth?.hostedModel?.label;
  return useMemo(
    () => hostedModelCatalogFromAuth(org?.auth),
    [id, label],
  );
}

export function restrictModelsToHostedCatalog<T extends { id: string; label: string }>(
  models: readonly T[],
  catalog: HostedModelCatalog | null,
): T[] {
  if (!catalog) return [...models];
  const match = models.find((model) => model.id === catalog.id);
  if (match) return [{ ...match, label: catalog.label }];
  return [{ id: catalog.id, label: catalog.label } as T];
}

export function applyHostedModelToConfig<T extends {
  model: string;
  apiProtocol?: string;
}>(config: T, catalog: HostedModelCatalog | null): T {
  if (!catalog) return config;
  if (config.model === catalog.id && config.apiProtocol === 'anthropic') return config;
  return {
    ...config,
    model: catalog.id,
    apiProtocol: 'anthropic',
  };
}

export function displayHostedModelLabel(
  modelId: string,
  catalog: HostedModelCatalog | null,
): string {
  if (catalog && (modelId === catalog.id || !modelId.trim())) return catalog.label;
  return modelId;
}
