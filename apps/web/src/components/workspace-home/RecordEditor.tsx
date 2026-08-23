// Creating or editing one document.
//
// The form is generated from the table's own schema, so a field someone added
// by asking appears here immediately with no code change. That is the whole
// promise of the soft-document model, and this component is where it either
// holds or does not.
//
// Two things it takes seriously: money is entered in the units people speak
// (12.50) and stored in the units the ledger requires (1250), and a document
// that can post to the books offers that as a separate, deliberate action.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from '@open-design/components';
import type { JsonValue, WorkspaceField, WorkspaceRecord, WorkspaceTable } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  createWorkspaceRecord,
  fetchNextDocumentNumber,
  fetchWorkspaceTables,
  postDocumentToLedger,
  queryWorkspaceRecords,
  updateWorkspaceRecord,
} from '../../providers/registry';
import styles from './RecordEditor.module.css';

interface Props {
  tableRef: string;
  recordId?: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

const POSTABLE = new Set(['invoices', 'payments']);

function roleOf(field: WorkspaceField): string | null {
  return (field.config as { role?: string } | null)?.role ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Money is integer minor units in the database and decimal in the world.
 * Convert at exactly these two points and nowhere else. */
function moneyToInput(value: unknown): string {
  return typeof value === 'number' ? (value / 100).toFixed(2) : '';
}

function inputToMoney(raw: string): number | null {
  const parsed = Number.parseFloat(raw.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function RecordEditor({ tableRef, recordId, onClose, onSaved }: Props) {
  const t = useT();
  const { activeOrgId } = useOptionalOrg() ?? NO_ORG_CONTEXT;
  const [table, setTable] = useState<WorkspaceTable | null>(null);
  const [record, setRecord] = useState<WorkspaceRecord | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [linkOptions, setLinkOptions] = useState<Record<string, Array<{ id: string; label: string }>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const tables = await fetchWorkspaceTables(activeOrgId);
      const found = tables.find((candidate) => candidate.name === tableRef || candidate.id === tableRef);
      if (!found) throw new Error(`table ${tableRef} not found`);
      setTable(found);

      // Link fields need something to choose from, and a person picks a
      // customer by name — never by id.
      const options: Record<string, Array<{ id: string; label: string }>> = {};
      for (const field of found.fields) {
        if (field.type !== 'link') continue;
        const targetId = (field.config as { targetTableId?: string } | null)?.targetTableId;
        const target = tables.find((candidate) => candidate.id === targetId);
        if (!target) continue;
        const page = await queryWorkspaceRecords(activeOrgId, target.name, { limit: 200 });
        const labelField =
          target.fields.find((candidate) => /^(name|title|full_name)$/.test(candidate.name)) ??
          target.fields.find((candidate) => candidate.type === 'text');
        options[field.name] = page.records.map((row) => ({
          id: row.id,
          label: labelField ? String(row.data[labelField.name] ?? row.id) : row.id,
        }));
      }
      setLinkOptions(options);

      if (recordId) {
        const page = await queryWorkspaceRecords(activeOrgId, found.name, { limit: 200 });
        const existing = page.records.find((row) => row.id === recordId) ?? null;
        setRecord(existing);
        const initial: Record<string, string> = {};
        for (const field of found.fields) {
          const raw = existing?.data[field.name];
          if (raw === undefined || raw === null) continue;
          initial[field.name] = field.type === 'money' ? moneyToInput(raw) : String(raw);
        }
        setValues(initial);
      } else {
        // A new document arrives pre-filled with the things nobody should
        // have to type: its number and today's date.
        const initial: Record<string, string> = {};
        const today = new Date().toISOString().slice(0, 10);
        for (const field of found.fields) {
          const role = roleOf(field);
          if (role === 'issue-date' || role === 'due-date') initial[field.name] = today;
          if (role === 'status') {
            const first = (field.config as { options?: string[] } | null)?.options?.[0];
            if (first) initial[field.name] = first;
          }
        }
        const numberField = found.fields.find((field) => roleOf(field) === 'document-number');
        if (numberField && POSTABLE.has(found.name) === false) {
          try {
            initial[numberField.name] = await fetchNextDocumentNumber(activeOrgId, found.name);
          } catch {
            // A missing suggestion is not worth blocking the form over.
          }
        } else if (numberField) {
          try {
            initial[numberField.name] = await fetchNextDocumentNumber(activeOrgId, found.name);
          } catch {
            // same
          }
        }
        setValues(initial);
      }
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [activeOrgId, tableRef, recordId]);

  useEffect(() => {
    void load();
  }, [load]);

  const editableFields = useMemo(
    () => (table ? table.fields.filter((field) => field.status === 'active') : []),
    [table],
  );

  function buildPayload(): Record<string, JsonValue> | null {
    const data: Record<string, JsonValue> = {};
    for (const field of editableFields) {
      const raw = values[field.name];
      if (raw === undefined || raw === '') {
        // Clearing a previously set field is meaningful on an edit.
        if (recordId && record && record.data[field.name] !== undefined) data[field.name] = null as never;
        continue;
      }
      switch (field.type) {
        case 'money': {
          const minor = inputToMoney(raw);
          if (minor === null) {
            setError(t('editor.badNumber', { field: field.displayName || field.name }));
            return null;
          }
          data[field.name] = minor;
          break;
        }
        case 'integer':
        case 'number':
        case 'datetime': {
          const parsed = field.type === 'integer' || field.type === 'datetime'
            ? Number.parseInt(raw, 10)
            : Number.parseFloat(raw);
          if (!Number.isFinite(parsed)) {
            setError(t('editor.badNumber', { field: field.displayName || field.name }));
            return null;
          }
          data[field.name] = parsed;
          break;
        }
        case 'boolean':
          data[field.name] = raw === 'true';
          break;
        case 'json':
          try {
            data[field.name] = JSON.parse(raw);
          } catch {
            setError(t('editor.badJson', { field: field.displayName || field.name }));
            return null;
          }
          break;
        default:
          data[field.name] = raw;
      }
    }
    return data;
  }

  async function handleSave() {
    if (!activeOrgId || !table || saving) return;
    const data = buildPayload();
    if (!data) return;
    setSaving(true);
    try {
      if (recordId) {
        await updateWorkspaceRecord(activeOrgId, recordId, { data });
      } else {
        await createWorkspaceRecord(activeOrgId, table.name, { data });
      }
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handlePost() {
    if (!activeOrgId || !table || !recordId) return;
    try {
      const result = await postDocumentToLedger(activeOrgId, table.name, recordId);
      setPosted(
        result.entry
          ? t('editor.postedEntry', { number: String(result.entry.number ?? '') })
          : t('editor.postSkipped', { reason: result.skipped ?? '' }),
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const canPost = Boolean(recordId && table && POSTABLE.has(table.name));

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" data-testid="record-editor">
      <div className={styles.panel}>
        <header className={styles.head}>
          <h2 className={styles.title}>
            {recordId
              ? t('editor.editTitle', { name: table?.displayName ?? tableRef })
              : t('editor.newTitle', { name: table?.displayName ?? tableRef })}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label={t('editor.close')}>
            ✕
          </Button>
        </header>

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}
        {posted ? <div className={styles.notice}>{posted}</div> : null}

        <div className={styles.form}>
          {editableFields.map((field) => {
            const id = `field-${field.id}`;
            const options = (field.config as { options?: string[] } | null)?.options;
            return (
              <div key={field.id} className={styles.field}>
                <label className={styles.label} htmlFor={id}>
                  {field.displayName || field.name}
                  {field.required ? <span className={styles.required}> *</span> : null}
                </label>
                {field.type === 'select' && options ? (
                  <Select
                    id={id}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  >
                    <option value="">—</option>
                    {options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </Select>
                ) : field.type === 'link' ? (
                  <Select
                    id={id}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  >
                    <option value="">—</option>
                    {(linkOptions[field.name] ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                ) : field.type === 'boolean' ? (
                  <Select
                    id={id}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  >
                    <option value="">—</option>
                    <option value="true">{t('editor.yes')}</option>
                    <option value="false">{t('editor.no')}</option>
                  </Select>
                ) : (
                  <Input
                    id={id}
                    type={field.type === 'date' ? 'date' : 'text'}
                    inputMode={field.type === 'money' || field.type === 'number' ? 'decimal' : undefined}
                    value={values[field.name] ?? ''}
                    placeholder={field.type === 'money' ? '0.00' : undefined}
                    onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
                  />
                )}
              </div>
            );
          })}
        </div>

        <footer className={styles.actions}>
          {canPost ? (
            <Button onClick={handlePost} data-testid="record-post">
              {t('editor.postToBooks')}
            </Button>
          ) : null}
          <div className={styles.actionsRight}>
            <Button variant="ghost" onClick={onClose}>
              {t('editor.cancel')}
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving} data-testid="record-save">
              {saving ? t('editor.saving') : t('editor.save')}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
