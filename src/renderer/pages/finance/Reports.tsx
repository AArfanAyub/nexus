/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Reports (T05) — trial balance, P&L, balance sheet, cash flow, general ledger.
 *
 * All five read the same server-computed numbers; this page never adds up a
 * column to produce a total that matters. Where a total is shown it comes from
 * the payload, so a report cannot disagree with itself.
 *
 * Two things are surfaced as *checks* rather than footnotes, because they are
 * the two ways an ERP loses its credibility:
 *   - the trial balance shows `balanced` and says so in words;
 *   - the balance sheet shows `A − (L + E) = 0` with the retained-earnings fold
 *     included, so a reader can see the identity holding rather than trust it.
 *
 * Drill-down is TB → GL → journal: clicking a trial-balance row opens the ledger
 * for that account, and clicking a ledger row opens the entry in the journal
 * browser via `?id=`.
 *
 * Export works on what is on screen: each view registers the rows it is
 * displaying, and the header button writes exactly those. An export that
 * silently writes a different set of rows than the reader is looking at is
 * worse than no export.
 */

import { AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type {
  BalanceSheet,
  CashFlow,
  LedgerPage,
  ProfitAndLoss,
  ReportGroup,
  TrialBalance,
  TrialBalanceRow,
} from '@shared/finance';

import { PageHeader } from '../../components/PageHeader';
import { EmptyState, DeltaChip, MoneyCell, Pagination, TableSkeleton } from '../../components/patterns';
import { Button, Chip, Input, Segmented } from '../../components/ui';
import {
  fetchBalanceSheet,
  fetchCashFlow,
  fetchLedger,
  fetchProfitAndLoss,
  fetchTrialBalance,
  fk,
  monthRange,
  today,
  yearRange,
} from '../../lib/finance';
import { amount, date as fmtDate } from '../../lib/format';
import { toast } from '../../lib/toast';
import { useQuery } from '../../lib/useQuery';
import { useSession } from '../../store';

type Tab = 'tb' | 'pnl' | 'bs' | 'cf' | 'gl';

const TABS: readonly { readonly value: Tab; readonly label: string }[] = [
  { value: 'tb', label: 'Trial balance' },
  { value: 'pnl', label: 'Profit & loss' },
  { value: 'bs', label: 'Balance sheet' },
  { value: 'cf', label: 'Cash flow' },
  { value: 'gl', label: 'General ledger' },
];

type Period = 'month' | 'year' | 'custom';

/** Rows a view hands to the exporter: a header, then one array per row. */
type CsvRows = readonly (readonly string[])[];

export function Reports(): JSX.Element {
  const navigate = useNavigate();
  const baseCurrency = useSession((state) => state.company?.baseCurrency ?? 'USD');
  const [tab, setTab] = useState<Tab>('tb');
  const [period, setPeriod] = useState<Period>('year');
  const [custom, setCustom] = useState(() => ({ from: `${today().slice(0, 4)}-01-01`, to: today() }));
  const [comparative, setComparative] = useState(true);
  const [ledgerAccount, setLedgerAccount] = useState<{ readonly id: string; readonly label: string } | null>(null);
  const [glPage, setGlPage] = useState(1);
  const [csvRows, setCsvRows] = useState<CsvRows>([]);

  const range = useMemo(() => {
    if (period === 'month') return monthRange(today());
    if (period === 'year') return yearRange(today());
    return custom;
  }, [period, custom]);

  const asOf = range.to;

  function drillTo(account: TrialBalanceRow): void {
    setLedgerAccount({ id: account.accountId, label: `${account.code} ${account.name}` });
    setGlPage(1);
    setTab('gl');
  }

  function exportCurrent(): void {
    if (csvRows.length === 0) {
      toast.info('Nothing to export yet', 'The report is still loading, or it has no rows for this period.');
      return;
    }
    const csv = csvRows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const name = `${tab}-${range.from}-to-${range.to}.csv`;
    try {
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.rel = 'noopener';
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success('Export ready', `${name} was written to your downloads folder.`);
    } catch {
      toast.error('That export failed', 'The file could not be written. Check the downloads folder permissions.');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Reports"
        subtitle={`All figures in ${baseCurrency}, accrual basis`}
        secondaryActions={
          <Button variant="ghost" iconLeft={<Download size={14} aria-hidden="true" />} onClick={exportCurrent}>
            Export CSV
          </Button>
        }
        primaryAction={
          <Button variant="primary" onClick={() => navigate('/finance/journal-entries')}>
            Open the journal
          </Button>
        }
        toolbar={
          <>
            <Segmented
              ariaLabel="Reporting period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: 'month', label: 'This month' },
                { value: 'year', label: 'This year' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {period === 'custom' ? (
              <>
                <Input
                  type="date"
                  aria-label="From"
                  value={custom.from}
                  onChange={(event) => setCustom({ ...custom, from: event.target.value })}
                  className="h-8 w-36"
                />
                <Input
                  type="date"
                  aria-label="To"
                  value={custom.to}
                  onChange={(event) => setCustom({ ...custom, to: event.target.value })}
                  className="h-8 w-36"
                />
              </>
            ) : (
              <span className="text-meta text-muted">
                {fmtDate(range.from)} — {fmtDate(range.to)}
              </span>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-meta text-muted">
              <input
                type="checkbox"
                checked={comparative}
                onChange={(event) => setComparative(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              Compare with the prior period
            </label>
          </>
        }
      />

      <div
        role="tablist"
        aria-label="Report"
        className="flex items-center gap-1 border-b border-line bg-surface px-4 py-1.5"
      >
        {TABS.map((item) => {
          const active = item.value === tab;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.value)}
              className={[
                'rounded-chip px-2.5 py-1 text-meta transition-colors duration-fast',
                active ? 'bg-accent-soft text-accent-strong' : 'text-muted hover:bg-surface-2 hover:text-text',
              ].join(' ')}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {tab === 'tb' ? <TrialBalanceView asOf={asOf} onDrill={drillTo} onRows={setCsvRows} /> : null}
        {tab === 'pnl' ? (
          <ProfitAndLossView from={range.from} to={range.to} comparative={comparative} onRows={setCsvRows} />
        ) : null}
        {tab === 'bs' ? <BalanceSheetView asOf={asOf} comparative={comparative} onRows={setCsvRows} /> : null}
        {tab === 'cf' ? <CashFlowView from={range.from} to={range.to} onRows={setCsvRows} /> : null}
        {tab === 'gl' ? (
          <LedgerView
            account={ledgerAccount}
            from={range.from}
            to={range.to}
            page={glPage}
            onPage={setGlPage}
            onOpenEntry={(id) => navigate(`/finance/journal-entries?id=${id}`)}
            onRows={setCsvRows}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── trial balance ────────────────────────────────────────────────────────────

function TrialBalanceView({
  asOf,
  onDrill,
  onRows,
}: {
  readonly asOf: string;
  readonly onDrill: (row: TrialBalanceRow) => void;
  readonly onRows: (rows: CsvRows) => void;
}): JSX.Element {
  const query = useQuery<TrialBalance>(fk.trialBalance(asOf), () => fetchTrialBalance(asOf), { staleMs: 30_000 });
  const report = query.data;

  useEffect(() => {
    if (!report) return;
    onRows([
      ['code', 'account', 'type', 'debit', 'credit', 'balance'],
      ...report.rows.map((row) => [
        row.code,
        row.name,
        row.type,
        amount(row.debitCents),
        amount(row.creditCents),
        amount(row.balanceCents),
      ]),
      ['', 'Total', '', amount(report.totals.debitCents), amount(report.totals.creditCents), ''],
    ]);
  }, [report, onRows]);

  if (query.error) return <ReportError message={query.error.message} />;
  if (!report) return <TableSkeleton rows={12} columns={5} />;

  if (report.rows.length === 0) {
    return (
      <EmptyState
        title="Nothing posted yet"
        description="A trial balance with no rows is correct for a company that has not posted a document. Post an invoice or a bill and it appears here."
      />
    );
  }

  return (
    <div className="space-y-3">
      <BalanceCheck
        ok={report.balanced}
        okLabel={`Debits equal credits at ${amount(report.totals.debitCents)}`}
        badLabel={`Out of balance by ${amount(report.totals.debitCents - report.totals.creditCents)}`}
      />

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <table className="w-full border-collapse text-body" aria-label="Trial balance">
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Code</th>
              <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">Account</th>
              <th scope="col" className="w-24 px-3 py-2 text-left text-meta font-medium text-muted">Type</th>
              <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Debit</th>
              <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Credit</th>
              <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Balance</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr
                key={row.accountId}
                tabIndex={0}
                onClick={() => onDrill(row)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onDrill(row);
                }}
                className="cursor-pointer border-b border-line transition-colors duration-fast hover:bg-surface-2"
                style={{ height: 'var(--row-h)' }}
              >
                <td className="px-3 font-mono text-code text-muted">{row.code}</td>
                <td className="px-3 text-text">{row.name}</td>
                <td className="px-3 text-meta capitalize text-muted">{row.type}</td>
                <td className="px-3 text-right">
                  {row.debitCents === 0 ? <span className="text-muted">—</span> : <MoneyCell>{amount(row.debitCents)}</MoneyCell>}
                </td>
                <td className="px-3 text-right">
                  {row.creditCents === 0 ? <span className="text-muted">—</span> : <MoneyCell>{amount(row.creditCents)}</MoneyCell>}
                </td>
                <td className="px-3 text-right">
                  <MoneyCell muted={row.balanceCents === 0}>{amount(row.balanceCents)}</MoneyCell>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface-2 font-medium">
              <td className="px-3 py-2 text-meta text-muted" colSpan={3}>
                {report.rows.length} accounts · as at {fmtDate(report.asOf)}
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyCell>{amount(report.totals.debitCents)}</MoneyCell>
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyCell>{amount(report.totals.creditCents)}</MoneyCell>
              </td>
              <td className="px-3 py-2 text-right">
                <MoneyCell>{amount(report.totals.debitCents - report.totals.creditCents)}</MoneyCell>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ── profit & loss ────────────────────────────────────────────────────────────

function ProfitAndLossView({
  from,
  to,
  comparative,
  onRows,
}: {
  readonly from: string;
  readonly to: string;
  readonly comparative: boolean;
  readonly onRows: (rows: CsvRows) => void;
}): JSX.Element {
  const query = useQuery<ProfitAndLoss>(
    fk.pnl(from, to, comparative),
    () => fetchProfitAndLoss(from, to, comparative),
    { staleMs: 30_000 },
  );
  const report = query.data;

  useEffect(() => {
    if (!report) return;
    const group = (name: string, value: ReportGroup): (readonly string[])[] => [
      [name, '', ''],
      ...value.rows.map((row) => [row.code, row.name, amount(row.currentCents)]),
      ['', `Total ${name.toLowerCase()}`, amount(value.currentCents)],
    ];
    onRows([
      ['code', 'account', 'current'],
      ...group('Income', report.income),
      ...group('Expense', report.expense),
      ['', 'Net profit', amount(report.netCurrentCents)],
    ]);
  }, [report, onRows]);

  if (query.error) return <ReportError message={query.error.message} />;
  if (!report) return <TableSkeleton rows={10} columns={3} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Income" value={report.income.currentCents} prior={report.income.comparativeCents} comparative={comparative} />
        <Stat label="Expense" value={report.expense.currentCents} prior={report.expense.comparativeCents} comparative={comparative} inverse />
        <Stat label="Net profit" value={report.netCurrentCents} prior={report.netComparativeCents} comparative={comparative} emphasis />
      </div>

      <GroupTable
        title="Income"
        group={report.income}
        comparative={comparative}
        periodLabel={`${fmtDate(report.from)} — ${fmtDate(report.to)}`}
      />
      <GroupTable
        title="Expense"
        group={report.expense}
        comparative={comparative}
        periodLabel={`${fmtDate(report.from)} — ${fmtDate(report.to)}`}
      />

      <div className="flex items-center justify-between rounded-card border border-line bg-surface px-4 py-3">
        <span className="text-body font-semibold text-text">Net profit for the period</span>
        <MoneyCell>{amount(report.netCurrentCents)}</MoneyCell>
      </div>
    </div>
  );
}

// ── balance sheet ────────────────────────────────────────────────────────────

function BalanceSheetView({
  asOf,
  comparative,
  onRows,
}: {
  readonly asOf: string;
  readonly comparative: boolean;
  readonly onRows: (rows: CsvRows) => void;
}): JSX.Element {
  const query = useQuery<BalanceSheet>(fk.balanceSheet(asOf, comparative), () => fetchBalanceSheet(asOf, comparative), {
    staleMs: 30_000,
  });
  const report = query.data;

  useEffect(() => {
    if (!report) return;
    const group = (name: string, value: ReportGroup): (readonly string[])[] => [
      [name, '', ''],
      ...value.rows.map((row) => [row.code, row.name, amount(row.currentCents)]),
      ['', `Total ${name.toLowerCase()}`, amount(value.currentCents)],
    ];
    onRows([
      ['code', 'account', 'current'],
      ...group('Assets', report.assets),
      ['', 'Total assets', amount(report.totalAssetsCents)],
      ...group('Liabilities', report.liabilities),
      ...group('Equity', report.equity),
      ['', 'Retained earnings (current year)', amount(report.retainedCents)],
      ['', 'Total liabilities and equity', amount(report.totalLiabilitiesCents + report.totalEquityCents)],
    ]);
  }, [report, onRows]);

  if (query.error) return <ReportError message={query.error.message} />;
  if (!report) return <TableSkeleton rows={10} columns={3} />;

  const difference = report.totalAssetsCents - (report.totalLiabilitiesCents + report.totalEquityCents);

  return (
    <div className="space-y-4">
      <BalanceCheck
        ok={report.balanced}
        okLabel={`Assets ${amount(report.totalAssetsCents)} = liabilities ${amount(report.totalLiabilitiesCents)} + equity ${amount(report.totalEquityCents)}`}
        badLabel={`Assets and liabilities plus equity differ by ${amount(difference)}`}
      />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <GroupTable
            title="Assets"
            group={report.assets}
            comparative={comparative}
            periodLabel={`as at ${fmtDate(report.asOf)}`}
          />
          <div className="flex items-center justify-between rounded-card border border-line-strong bg-surface px-4 py-2.5">
            <span className="text-body font-semibold text-text">Total assets</span>
            <MoneyCell>{amount(report.totalAssetsCents)}</MoneyCell>
          </div>
        </div>

        <div className="space-y-3">
          <GroupTable
            title="Liabilities"
            group={report.liabilities}
            comparative={comparative}
            periodLabel={`as at ${fmtDate(report.asOf)}`}
          />
          <GroupTable
            title="Equity"
            group={report.equity}
            comparative={comparative}
            periodLabel={`as at ${fmtDate(report.asOf)}`}
          />

          <div className="rounded-card border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-4 py-2">
              <span className="text-body text-text">Retained earnings (current year)</span>
              <MoneyCell>{amount(report.retainedCents)}</MoneyCell>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5">
              <span className="text-body font-semibold text-text">Total liabilities and equity</span>
              <MoneyCell>{amount(report.totalLiabilitiesCents + report.totalEquityCents)}</MoneyCell>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── cash flow ────────────────────────────────────────────────────────────────

function CashFlowView({
  from,
  to,
  onRows,
}: {
  readonly from: string;
  readonly to: string;
  readonly onRows: (rows: CsvRows) => void;
}): JSX.Element {
  const query = useQuery<CashFlow>(fk.cashFlow(from, to), () => fetchCashFlow(from, to), { staleMs: 30_000 });
  const report = query.data;

  useEffect(() => {
    if (!report) return;
    onRows([
      ['line', 'amount'],
      ['Opening cash', amount(report.openingCents)],
      ['Operating activities', amount(report.operatingCents)],
      ['Investing activities', amount(report.investingCents)],
      ['Financing activities', amount(report.financingCents)],
      ['Net movement', amount(report.netCents)],
      ['Closing cash', amount(report.closingCents)],
    ]);
  }, [report, onRows]);

  if (query.error) return <ReportError message={query.error.message} />;
  if (!report) return <TableSkeleton rows={8} columns={2} />;

  const lines: readonly { readonly label: string; readonly value: number; readonly strong?: boolean }[] = [
    { label: 'Opening cash', value: report.openingCents },
    { label: 'Operating activities', value: report.operatingCents },
    { label: 'Investing activities', value: report.investingCents },
    { label: 'Financing activities', value: report.financingCents },
    { label: 'Net movement', value: report.netCents, strong: true },
    { label: 'Closing cash', value: report.closingCents, strong: true },
  ];

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <table className="w-full border-collapse text-body" aria-label="Cash flow statement">
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className="px-4 py-2 text-left text-meta font-medium text-muted">Line</th>
              <th scope="col" className="w-44 px-4 py-2 text-right text-meta font-medium text-muted">
                {fmtDate(from)} — {fmtDate(to)}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.label} className="border-b border-line last:border-0" style={{ height: 'var(--row-h)' }}>
                <td className={line.strong ? 'px-4 font-semibold text-text' : 'px-4 text-text'}>{line.label}</td>
                <td className="px-4 text-right">
                  <MoneyCell muted={line.value === 0}>{amount(line.value)}</MoneyCell>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.lines.length > 0 ? (
        <div className="rounded-card border border-line bg-surface">
          <p className="border-b border-line px-4 py-2 micro">Movements behind the operating line</p>
          <ul className="divide-y divide-line">
            {report.lines.map((line) => (
              <li key={line.label} className="flex items-center justify-between px-4 py-1.5 text-body">
                <span className="text-muted">{line.label}</span>
                <MoneyCell>{amount(line.currentCents)}</MoneyCell>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-meta text-muted">
        Indirect method. A residual line absorbs any difference so opening plus the three sections equals closing
        exactly — the statement reconciles to the bank balance rather than to a rounding plug.
      </p>
    </div>
  );
}

// ── general ledger ───────────────────────────────────────────────────────────

function LedgerView({
  account,
  from,
  to,
  page,
  onPage,
  onOpenEntry,
  onRows,
}: {
  readonly account: { readonly id: string; readonly label: string } | null;
  readonly from: string;
  readonly to: string;
  readonly page: number;
  readonly onPage: (page: number) => void;
  readonly onOpenEntry: (id: string) => void;
  readonly onRows: (rows: CsvRows) => void;
}): JSX.Element {
  const query = useQuery<LedgerPage>(
    fk.ledger(account?.id ?? 'none', from, to, page),
    () => fetchLedger(account?.id ?? '', from, to, page),
    { enabled: account !== null, staleMs: 30_000 },
  );
  const ledger = query.data;

  useEffect(() => {
    if (!ledger) return;
    onRows([
      ['date', 'entry', 'description', 'debit', 'credit', 'running'],
      ...ledger.rows.map((row) => [
        row.date,
        row.number ?? '',
        row.description ?? row.memo ?? '',
        amount(row.debitCents),
        amount(row.creditCents),
        amount(row.runningCents),
      ]),
    ]);
  }, [ledger, onRows]);

  if (!account) {
    return (
      <EmptyState
        title="Pick an account"
        description="Open the trial balance and choose a row to see every posting on that account in date order, with a running balance."
      />
    );
  }
  if (query.error) return <ReportError message={query.error.message} />;
  if (!ledger) return <TableSkeleton rows={10} columns={5} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone="accent">{ledger.accountCode}</Chip>
        <span className="text-body font-medium text-text">{ledger.accountName}</span>
        <span className="text-meta text-muted">
          {fmtDate(ledger.from)} — {fmtDate(ledger.to)}
        </span>
        <span className="ml-auto flex items-center gap-3 text-meta text-muted">
          <span>
            Opening <MoneyCell muted>{amount(ledger.openingCents)}</MoneyCell>
          </span>
          <span>
            Closing <MoneyCell>{amount(ledger.closingCents)}</MoneyCell>
          </span>
        </span>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <table className="w-full border-collapse text-body" aria-label="General ledger">
          <thead className="bg-surface-2">
            <tr>
              <th scope="col" className="w-28 px-3 py-2 text-left text-meta font-medium text-muted">Date</th>
              <th scope="col" className="w-36 px-3 py-2 text-left text-meta font-medium text-muted">Entry</th>
              <th scope="col" className="px-3 py-2 text-left text-meta font-medium text-muted">Description</th>
              <th scope="col" className="w-28 px-3 py-2 text-right text-meta font-medium text-muted">Debit</th>
              <th scope="col" className="w-28 px-3 py-2 text-right text-meta font-medium text-muted">Credit</th>
              <th scope="col" className="w-32 px-3 py-2 text-right text-meta font-medium text-muted">Running</th>
            </tr>
          </thead>
          <tbody>
            {ledger.rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-meta text-muted">
                  No postings in this range. The opening and closing balance are equal.
                </td>
              </tr>
            ) : (
              ledger.rows.map((row) => (
                <tr
                  key={row.lineId}
                  tabIndex={0}
                  onClick={() => onOpenEntry(row.entryId)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onOpenEntry(row.entryId);
                  }}
                  className="cursor-pointer border-b border-line transition-colors duration-fast hover:bg-surface-2"
                  style={{ height: 'var(--row-h)' }}
                >
                  <td className="px-3 tabular-nums text-muted">{fmtDate(row.date)}</td>
                  <td className="px-3 font-mono text-code text-text">{row.number ?? '—'}</td>
                  <td className="truncate px-3 text-text">{row.description ?? row.memo ?? '—'}</td>
                  <td className="px-3 text-right">
                    {row.debitCents === 0 ? <span className="text-muted">—</span> : <MoneyCell>{amount(row.debitCents)}</MoneyCell>}
                  </td>
                  <td className="px-3 text-right">
                    {row.creditCents === 0 ? <span className="text-muted">—</span> : <MoneyCell>{amount(row.creditCents)}</MoneyCell>}
                  </td>
                  <td className="px-3 text-right">
                    <MoneyCell>{amount(row.runningCents)}</MoneyCell>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={ledger.page} pageSize={ledger.pageSize} total={ledger.total} onPage={onPage} />
    </div>
  );
}

// ── shared pieces ────────────────────────────────────────────────────────────

function GroupTable({
  title,
  group,
  comparative,
  periodLabel,
}: {
  readonly title: string;
  readonly group: ReportGroup;
  readonly comparative: boolean;
  readonly periodLabel: string;
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
        <h2 className="text-body font-semibold text-text">{title}</h2>
        <span className="text-meta text-muted">{periodLabel}</span>
      </div>
      {group.rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-meta text-muted">Nothing in this group for the period.</p>
      ) : (
        <table className="w-full border-collapse text-body" aria-label={title}>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="px-4 py-1.5 text-left text-meta font-medium text-muted">Account</th>
              {comparative ? (
                <th scope="col" className="w-32 px-4 py-1.5 text-right text-meta font-medium text-muted">Prior</th>
              ) : null}
              <th scope="col" className="w-32 px-4 py-1.5 text-right text-meta font-medium text-muted">Current</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.accountId} className="border-b border-line last:border-0" style={{ height: 'var(--row-h)' }}>
                <td className="px-4">
                  <span className="font-mono text-code text-muted">{row.code}</span>{' '}
                  <span className="text-text">{row.name}</span>
                </td>
                {comparative ? (
                  <td className="px-4 text-right">
                    <MoneyCell muted>{amount(row.comparativeCents)}</MoneyCell>
                  </td>
                ) : null}
                <td className="px-4 text-right">
                  <MoneyCell muted={row.currentCents === 0}>{amount(row.currentCents)}</MoneyCell>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface-2 font-medium">
              <td className="px-4 py-2 text-meta text-muted">Total {title.toLowerCase()}</td>
              {comparative ? (
                <td className="px-4 py-2 text-right">
                  <MoneyCell>{amount(group.comparativeCents)}</MoneyCell>
                </td>
              ) : null}
              <td className="px-4 py-2 text-right">
                <MoneyCell>{amount(group.currentCents)}</MoneyCell>
              </td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  prior,
  comparative,
  inverse = false,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly prior: number;
  readonly comparative: boolean;
  readonly inverse?: boolean;
  readonly emphasis?: boolean;
}): JSX.Element {
  const delta = prior === 0 ? (value === 0 ? 0 : 100) : ((value - prior) / Math.abs(prior)) * 100;
  return (
    <div
      className={
        emphasis ? 'rounded-card border border-line-strong bg-surface p-4' : 'rounded-card border border-line bg-surface p-4'
      }
    >
      <p className="micro">{label}</p>
      <p className="mt-1 text-kpi font-semibold tabular-nums text-text">{amount(value)}</p>
      {comparative ? (
        <p className="mt-1 flex items-center gap-1.5 text-meta text-muted">
          <DeltaChip value={delta} inverse={inverse} />
          <span>vs {amount(prior)}</span>
        </p>
      ) : null}
    </div>
  );
}

function BalanceCheck({
  ok,
  okLabel,
  badLabel,
}: {
  readonly ok: boolean;
  readonly okLabel: string;
  readonly badLabel: string;
}): JSX.Element {
  return (
    <div
      role="status"
      className={[
        'flex items-start gap-2 rounded-card border px-3 py-2 text-body',
        ok ? 'border-success bg-success-soft text-success' : 'border-danger bg-danger-soft text-danger',
      ].join(' ')}
    >
      {ok ? <CheckCircle2 size={16} aria-hidden="true" /> : <AlertTriangle size={16} aria-hidden="true" />}
      <span>{ok ? okLabel : badLabel}</span>
    </div>
  );
}

function ReportError({ message }: { readonly message: string }): JSX.Element {
  return (
    <div
      className="flex items-start gap-2 rounded-card border border-danger bg-danger-soft p-3 text-body text-danger"
      role="alert"
    >
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
