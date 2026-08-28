import type { ImportFromUrlResponse, ImportPlan } from '@open-design/contracts';
import { useT } from '../../i18n';
import { previewRowsFromCsv } from './importPreview';
import styles from './ImportDataPreview.module.css';

interface Props {
  plan: ImportPlan;
  content: string;
  source?: ImportFromUrlResponse['source'] | null;
}

export function ImportDataPreview({ plan, content, source }: Props) {
  const t = useT();
  const preview = previewRowsFromCsv(content, 10);
  const headers = plan.columns.length > 0 ? plan.columns.map((column) => column.header) : preview.headers;
  const extra = Math.max(0, preview.totalRows - preview.rows.length);
  const host = sourceHost(source?.finalUrl || source?.url);

  return (
    <div className={styles.wrap} data-testid="import-data-preview">
      <div className={styles.head}>
        <p className={styles.title}>{t('builder.previewTitle')}</p>
        {source ? (
          <a
            className={styles.source}
            href={source.finalUrl || source.url}
            target="_blank"
            rel="noreferrer"
            data-testid="import-source-link"
          >
            {t('builder.sourceLink')}
            {host ? ` · ${host}` : ''}
          </a>
        ) : null}
      </div>

      {preview.rows.length > 0 ? (
        <ul className={styles.cards} data-testid="import-preview-cards">
          {preview.rows.slice(0, 6).map((row, index) => (
            <li key={index} className={styles.card}>
              <strong>{row[0] || '—'}</strong>
              {headers.slice(1, 4).map((header, col) => {
                const value = row[col + 1];
                if (!value) return null;
                return (
                  <span key={header}>
                    <em>{header}</em>
                    {value}
                  </span>
                );
              })}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              {headers.map((header) => (
                <th key={header} scope="col">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={index}>
                {headers.map((header, col) => (
                  <td key={header}>{row[col] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {extra > 0 ? (
        <p className={styles.more}>{t('builder.previewMore', { count: String(extra) })}</p>
      ) : null}
    </div>
  );
}

function sourceHost(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
