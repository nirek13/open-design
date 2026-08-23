// The table every workspace surface uses for rows of records.
//
// Deliberately not a grid component: no resizing, no virtualization, no
// column menus. It renders a readable table, right-aligns money, and lets a
// row be clickable. Anything more belongs in the database view, which is the
// surface for working *on* the data rather than reading it.

import type { ReactNode } from 'react';
import styles from './DataTable.module.css';

export interface Column<Row> {
  key: string;
  header: string;
  /** Numeric and money columns align right so digits line up. */
  align?: 'start' | 'end';
  /** Renders the cell. Returning null shows the empty marker. */
  cell: (row: Row) => ReactNode;
  /** Hidden below the narrow breakpoint — for columns that are nice, not vital. */
  secondary?: boolean;
}

interface Props<Row> {
  columns: Array<Column<Row>>;
  rows: Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  /** Rendered instead of the table body when there are no rows. */
  empty?: ReactNode;
  caption?: string;
  testId?: string;
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  caption,
  testId,
}: Props<Row>) {
  if (rows.length === 0 && empty) {
    return <div className={styles.emptyWrap}>{empty}</div>;
  }

  return (
    <div className={styles.scroll} data-testid={testId}>
      <table className={styles.table}>
        {caption ? <caption className={styles.caption}>{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={[
                  column.align === 'end' ? styles.end : '',
                  column.secondary ? styles.secondary : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={onRowClick ? styles.clickable : undefined}
              // A clickable row still has to be reachable without a mouse.
              tabIndex={onRowClick ? 0 : undefined}
              role={onRowClick ? 'button' : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => {
                const content = column.cell(row);
                return (
                  <td
                    key={column.key}
                    className={[
                      column.align === 'end' ? styles.end : '',
                      column.secondary ? styles.secondary : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {content === null || content === undefined || content === '' ? (
                      <span className={styles.blank}>—</span>
                    ) : (
                      content
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
