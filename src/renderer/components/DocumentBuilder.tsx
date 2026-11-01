/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * DocumentBuilder — the three-pane editor every AR/AP document uses (§E.4, R2).
 *
 *   ┌────────────┬──────────────────────────────┬──────────────────┐
 *   │ meta/party │ lines, then totals           │ live A4 preview  │
 *   └────────────┴──────────────────────────────┴──────────────────┘
 *
 * The builder owns no data and no arithmetic: the page keeps the draft in state,
 * the main process computes the totals, and this component only decides where
 * things sit. That is why a peek drawer or a lock cannot lose a half-typed
 * document (US-06) — the draft lives above the layout, not inside it.
 *
 * The preview is a **scaled A4 sheet**, not a reflowed table. `renderPreviewHtml`
 * emits the same markup the PDF receives, scoped under `.doc-preview`, and the
 * container scales it with a transform. `frame-src 'none'` in the CSP rules out
 * an iframe, so the fragment is injected directly; every interpolation in the
 * template is escaped on the main side, which is what makes that safe.
 *
 * Keyboard, in the order the panes read: `Tab` walks meta → lines → totals →
 * actions. `⌘S` saves the draft and `⌘Enter` posts; both are wired by the page
 * so they work even when focus is in the line grid.
 */

import clsx from 'clsx';
import { useEffect, useRef, type ReactNode } from 'react';

import { Badge, Button, Skeleton } from './ui';

/**
 * Which documents the builder can lay out.
 *
 * `quote` and `purchase_order` joined the list when the sales and purchasing
 * chains shipped: a quotation and a purchase order are the same three-pane
 * problem as an invoice, and giving them their own layout would have been three
 * more places for the totals block to drift.
 */
export type BuilderDocType = 'invoice' | 'bill' | 'quote' | 'purchase_order';

export interface DocumentBuilderProps {
  readonly docType: BuilderDocType;
  readonly title: string;
  readonly subtitle?: string;
  /** Any document status. `draft` is the only one that means "not issued yet". */
  readonly status: string;
  readonly dirty: boolean;
  /** Left pane: partner, dates, currency, reference. */
  readonly meta: ReactNode;
  /** Centre pane: the line grid. */
  readonly lines: ReactNode;
  /** Centre pane, under the grid: subtotal / discount / tax / total. */
  readonly totals: ReactNode;
  /** Centre pane, under the totals: notes, terms. */
  readonly footer?: ReactNode;
  /** Right pane: the scoped HTML fragment from `documents.pdf.preview`. */
  readonly previewHtml: string | null;
  readonly previewBusy: boolean;
  readonly canSave: boolean;
  readonly canPost: boolean;
  readonly canVoid: boolean;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly onSave: () => void;
  readonly onPost: () => void;
  readonly onVoid: () => void;
  readonly onPrint: () => void;
  readonly onSavePdf: () => void;
  readonly onBack: () => void;
}

const DOC_LABEL: Record<BuilderDocType, string> = {
  invoice: 'Invoice',
  bill: 'Bill',
  quote: 'Quotation',
  purchase_order: 'Purchase order',
};

export function DocumentBuilder({
  docType,
  title,
  subtitle,
  status,
  dirty,
  meta,
  lines,
  totals,
  footer,
  previewHtml,
  previewBusy,
  canSave,
  canPost,
  canVoid,
  busy,
  readOnly,
  onSave,
  onPost,
  onVoid,
  onPrint,
  onSavePdf,
  onBack,
}: DocumentBuilderProps): JSX.Element {
  const frame = useRef<HTMLDivElement>(null);

  // The sheet is 210mm wide; the pane is ~340px. Scale to fit, never reflow.
  useEffect(() => {
    const node = frame.current;
    if (!node) return undefined;
    const fit = (): void => {
      const width = node.clientWidth;
      if (width <= 0) return;
      const a4 = 794; // 210mm at 96dpi
      node.style.setProperty('--doc-preview-scale', String(Math.min(1, (width - 24) / a4)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const posted = status !== 'draft';

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* ── action bar ─────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-surface px-5 py-2.5">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Back
        </Button>
        <div className="flex min-w-0 items-center gap-2">
          <span className="micro">{DOC_LABEL[docType]}</span>
          <h1 className="truncate text-title font-semibold text-text">{title}</h1>
          <Badge status={status} />
          {dirty && !readOnly ? <span className="text-meta text-warning">Unsaved changes</span> : null}
        </div>
        {subtitle ? <span className="hidden truncate text-meta text-muted md:inline">{subtitle}</span> : null}

        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={onPrint} disabled={busy}>
            Print
          </Button>
          <Button size="sm" variant="ghost" onClick={onSavePdf} disabled={busy}>
            Save PDF
          </Button>
          {canVoid && posted ? (
            <Button size="sm" variant="ghost" onClick={onVoid} disabled={busy}>
              Void
            </Button>
          ) : null}
          {canSave && !posted && !readOnly ? (
            <Button size="sm" variant="secondary" onClick={onSave} loading={busy} disabled={!dirty}>
              Save draft
            </Button>
          ) : null}
          {canPost && !posted ? (
            <Button size="sm" variant="primary" onClick={onPost} loading={busy}>
              Post
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── three panes ────────────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_380px]">
        <aside aria-label="Document details" className="min-h-0 overflow-y-auto border-b border-line bg-surface px-4 py-4 lg:border-b-0 lg:border-r">
          {meta}
        </aside>

        <section aria-label="Line items" className="flex min-h-0 flex-col overflow-y-auto">
          <div className="flex-1 px-5 py-4">{lines}</div>
          <div className="sticky bottom-0 border-t border-line bg-surface px-5 py-3">{totals}</div>
          {footer ? <div className="border-t border-line px-5 py-3">{footer}</div> : null}
        </section>

        <aside
          ref={frame}
          aria-label="Document preview"
          className="hidden min-h-0 overflow-hidden border-l border-line bg-surface-2 xl:block"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="micro">Preview · A4</span>
            {previewBusy ? <span className="text-[11px] text-muted">rendering…</span> : null}
          </div>
          <div className="h-[calc(100%-2.25rem)] overflow-y-auto p-3">
            {previewBusy && !previewHtml ? (
              <Skeleton height={520} />
            ) : previewHtml ? (
              <div
                className="doc-preview-scale"
                // Safe by construction: `renderPreviewHtml` escapes every
                // interpolation, and the only markup it emits is the template's
                // own. An iframe is not available — `frame-src 'none'`.
                dangerouslySetInnerHTML={{ __html: previewHtml }}
              />
            ) : (
              <div
                className={clsx(
                  'flex h-64 flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line-strong px-4 text-center',
                )}
              >
                <p className="text-body text-text">The preview appears once the document is saved</p>
                <p className="text-meta text-muted">
                  A number is only allocated at posting, so saving a draft is free — it reserves nothing and can be
                  deleted.
                </p>
                {canSave && !readOnly ? (
                  <Button size="sm" variant="secondary" onClick={onSave} disabled={busy}>
                    Save draft
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
