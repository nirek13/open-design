import type {
  CreateWorkspaceRecordRequest,
  CreateWorkspaceTableRequest,
  QueryWorkspaceRecordsRequest,
  UpdateWorkspaceRecordRequest,
  WorkspaceAuditEventsResponse,
  WorkspaceRecord,
  WorkspaceRecordRevision,
  OrganizationMembershipView,
  WorkspaceTable,
} from '@open-design/contracts';

import { requestJson } from './http.ts';

export async function listOrganizations(baseUrl: string): Promise<OrganizationMembershipView[]> {
  const response = await requestJson<{ organizations: OrganizationMembershipView[] }>(
    baseUrl,
    '/api/orgs',
  );
  return response.organizations;
}

export async function createOrganization(
  baseUrl: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const response = await requestJson<{ organization: { id: string; name: string } }>(
    baseUrl,
    '/api/orgs',
    { body: { name }, method: 'POST' },
  );
  return response.organization;
}

export async function listWorkspaceTables(baseUrl: string, orgId: string): Promise<WorkspaceTable[]> {
  const response = await requestJson<{ tables: WorkspaceTable[] }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/tables`,
  );
  return response.tables;
}

export async function createWorkspaceTable(
  baseUrl: string,
  orgId: string,
  body: CreateWorkspaceTableRequest,
): Promise<WorkspaceTable> {
  const response = await requestJson<{ table: WorkspaceTable }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/tables`,
    { body, method: 'POST' },
  );
  return response.table;
}

export async function createWorkspaceRecord(
  baseUrl: string,
  orgId: string,
  tableRef: string,
  body: CreateWorkspaceRecordRequest,
): Promise<WorkspaceRecord> {
  const response = await requestJson<{ record: WorkspaceRecord }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/tables/${encodeURIComponent(tableRef)}/records`,
    { body, method: 'POST' },
  );
  return response.record;
}

export async function queryWorkspaceRecords(
  baseUrl: string,
  orgId: string,
  tableRef: string,
  body: QueryWorkspaceRecordsRequest = {},
): Promise<{ nextCursor: string | null; records: WorkspaceRecord[] }> {
  return requestJson(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/tables/${encodeURIComponent(tableRef)}/records/query`,
    { body, method: 'POST' },
  );
}

export async function updateWorkspaceRecord(
  baseUrl: string,
  orgId: string,
  recordId: string,
  body: UpdateWorkspaceRecordRequest,
): Promise<WorkspaceRecord> {
  const response = await requestJson<{ record: WorkspaceRecord }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/records/${encodeURIComponent(recordId)}`,
    { body, method: 'PATCH' },
  );
  return response.record;
}

export async function softDeleteWorkspaceRecord(
  baseUrl: string,
  orgId: string,
  recordId: string,
): Promise<WorkspaceRecord> {
  const response = await requestJson<{ record: WorkspaceRecord }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/records/${encodeURIComponent(recordId)}/soft-delete`,
    { method: 'POST' },
  );
  return response.record;
}

export async function restoreWorkspaceRecord(
  baseUrl: string,
  orgId: string,
  recordId: string,
): Promise<WorkspaceRecord> {
  const response = await requestJson<{ record: WorkspaceRecord }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/records/${encodeURIComponent(recordId)}/restore`,
    { method: 'POST' },
  );
  return response.record;
}

export async function listWorkspaceRecordRevisions(
  baseUrl: string,
  orgId: string,
  recordId: string,
): Promise<WorkspaceRecordRevision[]> {
  const response = await requestJson<{ revisions: WorkspaceRecordRevision[] }>(
    baseUrl,
    `/api/data/orgs/${encodeURIComponent(orgId)}/records/${encodeURIComponent(recordId)}/revisions`,
  );
  return response.revisions;
}

export async function listWorkspaceAuditEvents(
  baseUrl: string,
  orgId: string,
  options: { limit?: number; tableId?: string } = {},
): Promise<WorkspaceAuditEventsResponse> {
  const query = new URLSearchParams();
  if (options.tableId) query.set('tableId', options.tableId);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return requestJson(baseUrl, `/api/data/orgs/${encodeURIComponent(orgId)}/audit${suffix}`);
}
