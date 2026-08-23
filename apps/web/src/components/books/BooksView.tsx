// The books.
//
// Four tabs, in the order an accountant asks for them: the trial balance
// (is everything consistent?), the journal (what happened?), the chart of
// accounts (where does it land?), and periods (what is final?).
//
// Two rules are visible in the interface rather than buried in the API:
// a posted entry is never edited — correcting it posts a mirror entry, so the
// original stays readable forever — and closing a period is presented as
// something you do deliberately, with the consequence spelled out.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Input, Skeleton } from '@open-design/components';
import type { JournalEntry, LedgerAccount, LedgerPeriod, TrialBalance } from '@open-design/contracts';
import { useT } from '../../i18n';
import { NO_ORG_CONTEXT, useOptionalOrg } from '../../org/OrgContext';
import {
  closeLedgerPeriod,
  fetchJournalEntries,
  fetchLedgerAccounts,
  fetchLedgerPeriods,
  fetchTrialBalance,
  reverseJournalEntry,
} from '../../providers/registry';
import { WorkspacePage, WorkspaceSection } from '../workspace/WorkspacePage';
import { DataTable, type Column } from '../workspace/DataTable';
import { StatCard } from '../workspace/StatCard';
import { formatDate, formatMoney } from '../workspace/format';
import styles from './BooksView.module.css';

interface Props {
  active: boolean;
}

type Tab = 'balance' | 'journal' | 'accounts' | 'periods';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function BooksView({ active }: Props) {
  const t = useT();
  const { activeOrgId, can } = useOptionalOrg() ?? NO_ORG_CONTEXT;

  const [tab, setTab] = useState<Tab>('balance');
  const [accounts, setAccounts] = useState<LedgerAccount[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [balance, setBalance] = useState<TrialBalance | null>(null);
  const [periods, setPeriods] = useState<LedgerPeriod[]>([]);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeStart, setCloseStart] = useState('');
  const [closeEnd, setCloseEnd] = useState('');

  const load = useCallback(async () => {
    if (!activeOrgId) return;
    try {
      const [nextAccounts, nextEntries, nextBalance, nextPeriods] = await Promise.all([
        fetchLedgerAccounts(activeOrgId),
        fetchJournalEntries(activeOrgId),
        fetchTrialBalance(activeOrgId),
        fetchLedgerPeriods(activeOrgId),
      ]);
      setAccounts(nextAccounts);
      setEntries(nextEntries);
      setBalance(nextBalance);
      setPeriods(nextPeriods);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [activeOrgId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const posted = useMemo(() => entries.filter((entry) => entry.status === 'posted'), [entries]);
  const openEntry = useMemo(
    () => entries.find((entry) => entry.id === openEntryId) ?? null,
    [entries, openEntryId],
  );
  const accountsByCode = useMemo(() => {
    const map = new Map<string, LedgerAccount>();
    for (const account of accounts) map.set(account.id, account);
    return map;
  }, [accounts]);

  async function handleReverse(entry: JournalEntry) {
    if (!activeOrgId || busy) return;
    setBusy(true);
    try {
      await reverseJournalEntry(activeOrgId, entry.id, t('books.reversalMemo'));
      setOpenEntryId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleClosePeriod() {
    if (!activeOrgId || !closeStart || !closeEnd || busy) return;
    setBusy(true);
    try {
      await closeLedgerPeriod(activeOrgId, closeStart, closeEnd);
      setCloseStart('');
      setCloseEnd('');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const entryColumns: Array<Column<JournalEntry>> = [
    {
      key: 'number',
      header: t('books.entryNumber'),
      cell: (entry) => (
        <span className={styles.mono}>{entry.number ?? t('books.draftShort')}</span>
      ),
    },
    { key: 'date', header: t('books.date'), cell: (entry) => formatDate(entry.date) },
    {
      key: 'memo',
      header: t('books.memo'),
      cell: (entry) => entry.memo ?? null,
    },
    {
      key: 'status',
      header: t('books.status'),
      secondary: true,
      cell: (entry) => (
        <Badge
          tone={
            entry.status === 'posted'
              ? entry.reversedByEntryId
                ? 'neutral'
                : 'positive'
              : entry.status === 'reversed'
                ? 'neutral'
                : 'warning'
          }
          dot
        >
          {entry.reversedByEntryId ? t('books.statusReversed') : t(`books.status_${entry.status}` as never)}
        </Badge>
      ),
    },
    {
      key: 'amount',
      header: t('books.amount'),
      align: 'end',
      cell: (entry) => {
        // Debits equal credits by construction, so either side is "the amount".
        const total = entry.lines
          .filter((line) => line.direction === 'debit')
          .reduce((sum, line) => sum + line.amount, 0);
        return <span className={styles.mono}>{formatMoney(total)}</span>;
      },
    },
  ];

  const tabs = [
    { id: 'balance', label: t('books.tabBalance') },
    { id: 'journal', label: t('books.tabJournal'), count: posted.length },
    { id: 'accounts', label: t('books.tabAccounts'), count: accounts.length },
    { id: 'periods', label: t('books.tabPeriods') },
  ];

  return (
    <WorkspacePage
      testId="books-view"
      title={t('books.title')}
      lead={t('books.lead')}
      tabs={tabs}
      activeTab={tab}
      onTabChange={(id) => setTab(id as Tab)}
    >
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <div className={styles.skeletonList}>
          <Skeleton shape="block" height={72} />
          <Skeleton shape="block" height={220} />
        </div>
      ) : null}

      {loaded && tab === 'balance' ? (
        <>
          <div className={styles.statRow}>
            <StatCard
              label={t('books.totalDebits')}
              value={formatMoney(balance?.totalDebit ?? 0)}
              testId="books-total-debits"
            />
            <StatCard label={t('books.totalCredits')} value={formatMoney(balance?.totalCredit ?? 0)} />
            <StatCard
              label={t('books.balanced')}
              value={balance?.balanced === false ? t('books.no') : t('books.yes')}
              detail={balance ? t('books.asOf', { date: formatDate(balance.asOf) }) : undefined}
              tone={balance?.balanced === false ? 'danger' : 'positive'}
              testId="books-balanced"
            />
          </div>

          {/* If this is ever false the books are broken, and saying so quietly
              would be the wrong call. */}
          {balance?.balanced === false ? (
            <div className={styles.alarm} role="alert" data-testid="books-unbalanced-alarm">
              {t('books.unbalancedWarning')}
            </div>
          ) : null}

          <WorkspaceSection title={t('books.tabBalance')}>
            <DataTable
              testId="books-trial-balance"
              rows={balance?.rows ?? []}
              rowKey={(row) => row.accountId}
              empty={
                <EmptyState
                  title={t('books.noEntriesTitle')}
                  description={t('books.noEntriesBody')}
                />
              }
              columns={[
                { key: 'code', header: t('books.code'), cell: (row) => <span className={styles.mono}>{row.code}</span> },
                { key: 'name', header: t('books.account'), cell: (row) => row.name },
                {
                  key: 'type',
                  header: t('books.type'),
                  secondary: true,
                  cell: (row) => <span className={styles.type}>{t(`books.type_${row.type}` as never)}</span>,
                },
                {
                  key: 'debit',
                  header: t('books.debit'),
                  align: 'end',
                  cell: (row) => (row.debit ? formatMoney(row.debit) : null),
                },
                {
                  key: 'credit',
                  header: t('books.credit'),
                  align: 'end',
                  cell: (row) => (row.credit ? formatMoney(row.credit) : null),
                },
              ]}
            />
          </WorkspaceSection>
        </>
      ) : null}

      {loaded && tab === 'journal' ? (
        <WorkspaceSection
          title={t('books.tabJournal')}
          action={<span className={styles.hint}>{t('books.journalHint')}</span>}
        >
          <DataTable
            testId="books-journal"
            rows={entries}
            rowKey={(entry) => entry.id}
            onRowClick={(entry) => setOpenEntryId(entry.id)}
            columns={entryColumns}
            empty={
              <EmptyState title={t('books.noEntriesTitle')} description={t('books.noEntriesBody')} />
            }
          />
        </WorkspaceSection>
      ) : null}

      {loaded && tab === 'accounts' ? (
        <WorkspaceSection title={t('books.tabAccounts')}>
          <DataTable
            testId="books-accounts"
            rows={accounts}
            rowKey={(account) => account.id}
            columns={[
              {
                key: 'code',
                header: t('books.code'),
                cell: (account) => <span className={styles.mono}>{account.code}</span>,
              },
              { key: 'name', header: t('books.account'), cell: (account) => account.name },
              {
                key: 'type',
                header: t('books.type'),
                cell: (account) => (
                  <span className={styles.type}>{t(`books.type_${account.type}` as never)}</span>
                ),
              },
              {
                key: 'currency',
                header: t('books.currency'),
                secondary: true,
                align: 'end',
                cell: (account) => account.currency,
              },
            ]}
            empty={<EmptyState title={t('books.noAccounts')} description={t('books.noAccountsBody')} />}
          />
        </WorkspaceSection>
      ) : null}

      {loaded && tab === 'periods' ? (
        <>
          <WorkspaceSection title={t('books.tabPeriods')}>
            <DataTable
              testId="books-periods"
              rows={periods}
              rowKey={(period) => period.id}
              columns={[
                {
                  key: 'range',
                  header: t('books.period'),
                  cell: (period) => `${formatDate(period.startDate)} – ${formatDate(period.endDate)}`,
                },
                {
                  key: 'status',
                  header: t('books.status'),
                  cell: (period) => (
                    <Badge tone={period.status === 'closed' ? 'neutral' : 'positive'} dot>
                      {period.status === 'closed' ? t('books.closed') : t('books.open')}
                    </Badge>
                  ),
                },
              ]}
              empty={
                <EmptyState title={t('books.noPeriods')} description={t('books.noPeriodsBody')} />
              }
            />
          </WorkspaceSection>

          {can('owner') ? (
            <WorkspaceSection title={t('books.closeTitle')}>
              <div className={styles.closeCard} data-testid="books-close-period">
                <p className={styles.closeBody}>{t('books.closeBody')}</p>
                <div className={styles.closeRow}>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('books.from')}</span>
                    <Input
                      type="date"
                      value={closeStart}
                      onChange={(event) => setCloseStart(event.target.value)}
                      data-testid="books-close-start"
                    />
                  </label>
                  <label className={styles.field}>
                    <span className={styles.fieldLabel}>{t('books.to')}</span>
                    <Input
                      type="date"
                      value={closeEnd}
                      onChange={(event) => setCloseEnd(event.target.value)}
                      data-testid="books-close-end"
                    />
                  </label>
                  <Button
                    variant="primary"
                    onClick={handleClosePeriod}
                    disabled={!closeStart || !closeEnd || busy}
                    data-testid="books-close-submit"
                  >
                    {busy ? t('books.closing') : t('books.closeAction')}
                  </Button>
                </div>
              </div>
            </WorkspaceSection>
          ) : null}
        </>
      ) : null}

      {openEntry ? (
        <div
          className={styles.drawerBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={t('books.entryTitle', { number: String(openEntry.number ?? '') })}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpenEntryId(null);
          }}
          data-testid="books-entry-drawer"
        >
          <div className={styles.drawer}>
            <header className={styles.drawerHead}>
              <div>
                <h2 className={styles.drawerTitle}>
                  {t('books.entryTitle', { number: String(openEntry.number ?? '—') })}
                </h2>
                <p className={styles.drawerMeta}>
                  {formatDate(openEntry.date)}
                  {openEntry.memo ? ` · ${openEntry.memo}` : ''}
                </p>
              </div>
              <Button variant="ghost" onClick={() => setOpenEntryId(null)} aria-label={t('books.close')}>
                ✕
              </Button>
            </header>

            {openEntry.reversesEntryId ? (
              <p className={styles.drawerNote}>{t('books.isReversal')}</p>
            ) : null}
            {openEntry.reversedByEntryId ? (
              <p className={styles.drawerNote}>{t('books.wasReversed')}</p>
            ) : null}

            <table className={styles.lineTable}>
              <thead>
                <tr>
                  <th scope="col">{t('books.account')}</th>
                  <th scope="col" className={styles.numeric}>
                    {t('books.debit')}
                  </th>
                  <th scope="col" className={styles.numeric}>
                    {t('books.credit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {openEntry.lines.map((line) => {
                  const account = accountsByCode.get(line.accountId);
                  return (
                    <tr key={line.id}>
                      <td>
                        <span className={styles.mono}>{account?.code ?? ''}</span>{' '}
                        {account?.name ?? line.accountId}
                      </td>
                      <td className={styles.numeric}>
                        {line.direction === 'debit' ? formatMoney(line.amount) : ''}
                      </td>
                      <td className={styles.numeric}>
                        {line.direction === 'credit' ? formatMoney(line.amount) : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <footer className={styles.drawerFoot}>
              {/* Editing a posted entry is not offered anywhere, because it is
                  not possible: the correction is a new, linked entry. */}
              {openEntry.status === 'posted' && !openEntry.reversedByEntryId ? (
                <Button onClick={() => handleReverse(openEntry)} disabled={busy} data-testid="books-reverse">
                  {busy ? t('books.reversing') : t('books.reverse')}
                </Button>
              ) : null}
              <span className={styles.drawerHint}>{t('books.immutableHint')}</span>
            </footer>
          </div>
        </div>
      ) : null}
    </WorkspacePage>
  );
}
