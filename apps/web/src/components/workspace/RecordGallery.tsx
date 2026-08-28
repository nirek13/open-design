import type { WorkspaceField, WorkspaceRecord } from '@open-design/contracts';
import { formatMoney } from './format';
import styles from './RecordGallery.module.css';

interface Props {
  fields: WorkspaceField[];
  records: WorkspaceRecord[];
  onOpen?: (recordId: string) => void;
  testId?: string;
}

function cellText(value: unknown, field: WorkspaceField): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'money' && typeof value === 'number') return formatMoney(value);
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function RecordGallery({ fields, records, onOpen, testId }: Props) {
  const shown = fields.slice(0, 5);
  const titleField = shown[0];
  return (
    <ul className={styles.grid} data-testid={testId ?? 'record-gallery'}>
      {records.map((record) => {
        const title = titleField ? cellText(record.data[titleField.name], titleField) : record.id.slice(0, 8);
        const rest = shown.slice(1).flatMap((field) => {
          const text = cellText(record.data[field.name], field);
          return text ? [{ id: field.id, label: field.displayName, text }] : [];
        });
        return (
          <li key={record.id}>
            <button
              type="button"
              className={styles.card}
              onClick={() => onOpen?.(record.id)}
              data-testid={`record-card-${record.id}`}
            >
              <span className={styles.title}>{title || '—'}</span>
              {rest.map((item) => (
                <span key={item.id} className={styles.meta}>
                  <em>{item.label}</em>
                  {item.text}
                </span>
              ))}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
