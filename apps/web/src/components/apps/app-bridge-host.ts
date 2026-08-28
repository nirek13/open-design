// Host side of `window.od`: turn iframe postMessage into ordinary /api/data calls.
//
// AppRunner uses declared scopes. The project HTML preview uses `preview`,
// which still rides the signed-in member's session — the iframe itself has
// no network.

import {
  APP_BRIDGE_PROTOCOL,
  APP_GMAIL_SCOPE_TABLE,
  scopeAllows,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type AppDataScope,
} from '@open-design/contracts';
import {
  createWorkspaceRecord,
  fetchWorkspaceTables,
  queryWorkspaceRecords,
  sendOrgMail,
  updateWorkspaceRecord,
} from '../../providers/registry';

export function isAppBridgeRequest(data: unknown): data is AppBridgeRequest {
  if (!data || typeof data !== 'object') return false;
  const request = data as AppBridgeRequest;
  return request.protocol === APP_BRIDGE_PROTOCOL && typeof request.id === 'string' && typeof request.kind === 'string';
}

export function tableForAppBridgeRequest(request: AppBridgeRequest): string | null {
  if (request.kind === 'mail.send') return APP_GMAIL_SCOPE_TABLE;
  return 'table' in request ? request.table : null;
}

export class AppBridgeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppBridgeRefused';
  }
}

export async function performAppBridgeRequest(
  orgId: string,
  request: AppBridgeRequest,
  scopes: readonly AppDataScope[] | 'preview',
): Promise<unknown> {
  if (scopes !== 'preview') {
    const decision = scopeAllows(scopes, request);
    if (!decision.allowed) throw new AppBridgeRefused(decision.reason ?? 'refused');
  }

  switch (request.kind) {
    case 'scopes': {
      if (scopes === 'preview') {
        const tables = await fetchWorkspaceTables(orgId);
        return {
          scopes: tables
            .filter((table) => table.status === 'active')
            .map((table) => ({ table: table.name, mode: 'write' as const })),
        };
      }
      return { scopes };
    }
    case 'describe': {
      const tables = await fetchWorkspaceTables(orgId);
      const table = tables.find((candidate) => candidate.name === request.table);
      if (!table) throw new Error(`no table '${request.table}'`);
      return {
        name: table.name,
        displayName: table.displayName,
        fields: table.fields.map((field) => ({
          name: field.name,
          displayName: field.displayName,
          type: field.type,
          required: field.required,
          options: (field.config as { options?: string[] } | null)?.options ?? null,
        })),
      };
    }
    case 'query': {
      const result = await queryWorkspaceRecords(orgId, request.table, {
        ...(request.filters ? { filters: request.filters as never } : {}),
        ...(request.sort ? { sort: request.sort } : {}),
        limit: Math.min(Math.max(1, request.limit ?? 100), 500),
      });
      return { records: result.records };
    }
    case 'create': {
      const record = await createWorkspaceRecord(orgId, request.table, {
        data: request.data as never,
      });
      return { record };
    }
    case 'update': {
      const record = await updateWorkspaceRecord(orgId, request.recordId, {
        data: request.data as never,
      });
      return { record };
    }
    case 'mail.send': {
      const to = Array.isArray(request.to) ? request.to : [request.to];
      const cc = request.cc === undefined ? undefined : Array.isArray(request.cc) ? request.cc : [request.cc];
      const bcc = request.bcc === undefined ? undefined : Array.isArray(request.bcc) ? request.bcc : [request.bcc];
      return sendOrgMail(orgId, {
        to,
        cc,
        bcc,
        subject: typeof request.subject === 'string' ? request.subject : '',
        body: typeof request.body === 'string' ? request.body : '',
        isHtml: request.isHtml === true,
      });
    }
    default:
      throw new Error('unsupported request');
  }
}

export function replyAppBridge(target: Window | null, response: AppBridgeResponse): void {
  target?.postMessage(response, '*');
}
