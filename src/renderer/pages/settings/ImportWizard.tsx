/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * The import wizard (T10).
 *
 * Four steps, each one a call to the server, each one something the operator can
 * look at before moving on:
 *
 *   1. entity + file      → `data.import.pick`, `data.import.parse`
 *   2. mapping            → every header matched to a field, with a confidence
 *   3. validation report  → `data.import.validate`, then read it and decide
 *   4. commit             → `data.import.commit`, with `job:progress` bars
 *
 * The report is the product. "197 of 200 will be created, 3 rows have no code"
 * is what makes an import trustworthy; a spinner that says "done" is not.
 */

import { useEffect, useState } from 'react';

import type {
  ImportCommitResult,
  ImportEntity,
  ImportParseResult,
  ImportProgress,
  ImportValidationReport,
} from '@shared/admin';

import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Button, Chip, Select } from '../../components/ui';
import { invoke, onMainEvent } from '../../lib/api';
import { invalidate } from '../../lib/useQuery';
import { toast } from '../../lib/toast';

const ENTITIES: readonly { readonly value: ImportEntity; readonly label: string }[] = [
  { value: 'customers', label: 'Customers' },
  { value: 'vendors', label: 'Vendors' },
  { value: 'products', label: 'Products' },
  { value: 'crmAccounts', label: 'CRM accounts' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'leads', label: 'Leads' },
  { value: 'deals', label: 'Deals' },
];

type Step = 'choose' | 'map' | 'report' | 'done';

export function ImportWizard(): JSX.Element {
  const [entity, setEntity] = useState<ImportEntity>('customers');
  const [step, setStep] = useState<Step>('choose');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [report, setReport] = useState<ImportValidationReport | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);

  useEffect(() => {
    return onMainEvent('job:progress', (payload) => {
      const value = payload as ImportProgress;
      if (value && typeof value.done === 'number') setProgress(value);
    });
  }, []);

  async function choose(): Promise<void> {
    try {
      const picked = await invoke<{ path: string | null }>('data.import.pick', {});
      if (!picked.path) return;
      setBusy(true);
      const parsedFile = await invoke<ImportParseResult>('data.import.parse', { entity, path: picked.path });
      setParsed(parsedFile);
      setMapping(Object.fromEntries(parsedFile.columns.filter((column) => column.field !== null).map((column) => [column.header, column.field as string])));
      setReport(null);
      setResult(null);
      setStep('map');
    } catch (error) {
      toast.error('The file could not be read', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function validate(): Promise<void> {
    if (!parsed) return;
    setBusy(true);
    try {
      const validation = await invoke<ImportValidationReport>('data.import.validate', {
        batchId: parsed.batchId,
        mapping,
        updateExisting,
      });
      setReport(validation);
      setStep('report');
    } catch (error) {
      toast.error('Validation failed', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function commit(): Promise<void> {
    if (!parsed) return;
    setBusy(true);
    setProgress(null);
    try {
      const committed = await invoke<ImportCommitResult>('data.import.commit', { batchId: parsed.batchId });
      setResult(committed);
      setStep('done');
      invalidate('');
      toast.success(
        `${String(committed.inserted + committed.updated)} rows imported`,
        committed.failed > 0 ? `${String(committed.failed)} could not be saved.` : undefined,
      );
    } catch (error) {
      toast.error('The import failed', error instanceof Error ? error.message : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function downloadTemplate(): Promise<void> {
    try {
      const template = await invoke<{ filename: string; csv: string }>('data.import.template', { entity });
      const blob = new Blob([template.csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = template.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error('Could not build the template', error instanceof Error ? error.message : undefined);
    }
  }

  function reset(): void {
    setStep('choose');
    setParsed(null);
    setMapping({});
    setReport(null);
    setResult(null);
    setProgress(null);
  }

  return (
    <div className="space-y-3">
      <SectionCard
        title="Import"
        description="CSV or XLSX. Nothing is written until the last step, and only the rows the report calls valid."
        actions={
          <>
            <Select
              aria-label="Entity"
              value={entity}
              onChange={(event) => {
                setEntity(event.target.value as ImportEntity);
                reset();
              }}
              options={ENTITIES.map((entry) => ({ value: entry.value, label: entry.label }))}
              className="w-40"
            />
            <Button variant="ghost" onClick={() => void downloadTemplate()}>
              Template
            </Button>
            {step === 'choose' ? (
              <Button variant="primary" onClick={() => void choose()} loading={busy}>
                Choose file…
              </Button>
            ) : (
              <Button variant="ghost" onClick={reset}>
                Start over
              </Button>
            )}
          </>
        }
      >
        {step === 'choose' ? (
          <EmptyState
            title="No file chosen"
            description="Download the template first if the columns are not obvious — it is the shape the wizard expects."
          />
        ) : !parsed ? null : step === 'map' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-meta text-muted">
              <Chip tone="neutral">{parsed.filename}</Chip>
              <span>{parsed.totalRows} rows</span>
              <span>{parsed.headers.length} columns</span>
              {parsed.parseErrors.length > 0 ? <Chip tone="warning">{parsed.parseErrors.length} unreadable</Chip> : null}
            </div>
            <table className="w-full text-meta">
              <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-2 py-1.5">Column in the file</th>
                  <th className="px-2 py-1.5">Field</th>
                  <th className="px-2 py-1.5">Confidence</th>
                  <th className="px-2 py-1.5">Sample</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {parsed.columns.map((column) => (
                  <tr key={column.header}>
                    <td className="px-2 py-1.5 text-text">{column.header}</td>
                    <td className="px-2 py-1.5">
                      <Select
                        aria-label={`Map ${column.header}`}
                        value={mapping[column.header] ?? ''}
                        onChange={(event) =>
                          setMapping((current) => ({ ...current, [column.header]: event.target.value }))
                        }
                        options={[
                          { value: '', label: '— ignore —' },
                          ...parsed.columns
                            .filter((entry) => entry.field !== null)
                            .map((entry) => ({ value: entry.field as string, label: entry.field as string })),
                        ]}
                        className="w-40"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {mapping[column.header] ? (
                        <Chip tone={column.confidence >= 100 ? 'success' : column.confidence >= 60 ? 'warning' : 'neutral'}>
                          {column.confidence}%
                        </Chip>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate px-2 py-1.5 text-muted">{column.sample.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <label className="flex items-center gap-2 text-meta text-muted">
              <input
                type="checkbox"
                checked={updateExisting}
                onChange={(event) => setUpdateExisting(event.target.checked)}
              />
              Update records that already exist instead of rejecting them
            </label>
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => void validate()} loading={busy}>
                Validate {parsed.totalRows} rows
              </Button>
            </div>
          </div>
        ) : step === 'report' && report ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Chip tone="success">{report.validRows} will be imported</Chip>
              <Chip tone="danger">{report.invalidRows} invalid</Chip>
              <Chip tone="warning">{report.duplicateRows} duplicates</Chip>
              <Chip tone="neutral">{report.totalRows} in the file</Chip>
            </div>
            {report.errors.length === 0 ? (
              <EmptyState title="Every row passed" description="Nothing to fix. Import when ready." />
            ) : (
              <div className="max-h-72 overflow-y-auto">
                <table className="w-full text-meta">
                  <thead className="sticky top-0 bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-2 py-1.5">Row</th>
                      <th className="px-2 py-1.5">Column</th>
                      <th className="px-2 py-1.5">Reason</th>
                      <th className="px-2 py-1.5">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {report.errors.slice(0, 200).map((error, index) => (
                      <tr key={`${String(error.row)}-${String(index)}`}>
                        <td className="px-2 py-1 text-right tabular-nums text-muted">{error.row}</td>
                        <td className="px-2 py-1 text-text">{error.column ?? '—'}</td>
                        <td className="px-2 py-1 text-danger">{error.reason}</td>
                        <td className="max-w-[200px] truncate px-2 py-1 text-muted">{error.value ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {report.errors.length > 200 ? (
                  <p className="px-2 py-1 text-[11px] text-muted">Showing the first 200 of {report.errors.length}.</p>
                ) : null}
              </div>
            )}
            {progress ? (
              <div>
                <div className="mb-1 flex justify-between text-[11px] text-muted">
                  <span>{progress.phase}</span>
                  <span className="tabular-nums">
                    {progress.done} / {progress.total}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                  <div
                    className="h-full bg-accent transition-[width] duration-150"
                    style={{ width: `${String(Math.round((progress.done / Math.max(1, progress.total)) * 100))}%` }}
                  />
                </div>
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep('map')}>
                Back to mapping
              </Button>
              <Button variant="primary" onClick={() => void commit()} loading={busy} disabled={report.validRows === 0}>
                Import {report.validRows} rows
              </Button>
            </div>
          </div>
        ) : step === 'done' && result ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Chip tone="success">{result.inserted} created</Chip>
              <Chip tone="accent">{result.updated} updated</Chip>
              <Chip tone="warning">{result.skipped} skipped</Chip>
              <Chip tone="danger">{result.failed} failed</Chip>
              <Chip tone="neutral">{result.ms} ms</Chip>
            </div>
            {result.errorCsvPath ? (
              <p className="text-meta text-muted">
                Rows that could not be saved were written to <span className="font-mono">{result.errorCsvPath}</span>.
              </p>
            ) : (
              <p className="text-meta text-muted">Nothing failed at insert time.</p>
            )}
            <div className="flex justify-end">
              <Button onClick={reset}>Import another file</Button>
            </div>
          </div>
        ) : (
          <TableSkeleton rows={3} columns={3} />
        )}
      </SectionCard>
    </div>
  );
}
