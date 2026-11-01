/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `LineGrid` — the editable line table shared by the purchase-order builder, the
 * quotation builder and the receipt screen (T08 gap closure).
 *
 * Three documents, one grid. The alternative — a bespoke table per builder — is
 * how a product ends up where `Backspace` deletes a row in the PO builder and
 * does nothing in the quote builder.
 *
 * The grid is *dumb on purpose*: it holds text, never numbers. Every value the
 * operator types stays a string until `toLineInputs` converts it at the moment
 * of saving, so a half-typed `12.` never becomes `12` behind their back and a
 * comma-grouped `1,250.00` survives being pasted from a supplier's PDF.
 *
 * Totals are shown per line and in the footer, but they are computed from the
 * converted integers, not from the strings — the same arithmetic the server will
 * do, so the footer cannot promise a total the server then refuses.
 */

import { Plus, Trash2 } from 'lucide-react';
import { useMemo } from 'react';

import type { PoLineInput, SaleLineInput } from '@shared/ops';

import { Button, IconButton, Input, Select, Tooltip } from './ui';

/** One editable row. All money and quantity fields are strings while typing. */
export interface LineDraft {
  /** Stable key for React; never sent to the server. */
  readonly key: string;
  productId: string;
  description: string;
  /** Whole units as typed, e.g. `12` or `1.5`. */
  qty: string;
  /** Currency units as typed, e.g. `1250.00`. */
  unitPrice: string;
  /** Percentage as typed, e.g. `5`. Only rendered when `showDiscount`. */
  discount: string;
  taxId: string;
}

export interface LineGridProps {
  readonly rows: readonly LineDraft[];
  readonly onChange: (rows: LineDraft[]) => void;
  readonly products: readonly { readonly value: string; readonly label: string }[];
  readonly taxes: readonly { readonly value: string; readonly label: string }[];
  readonly currency: string;
  readonly showDiscount?: boolean;
  readonly showTax?: boolean;
  readonly readOnly?: boolean;
  /** Replaces the quantity input — the receipt screen caps against the PO line. */
  readonly renderQty?: (row: LineDraft, index: number, set: (value: string) => void) => JSX.Element;
  /** Shown under the grid, right-aligned. */
  readonly footerNote?: string;
  readonly error?: string | null;
}

let seq = 0;

/** A blank row with a fresh key. Exported so pages can seed a builder. */
export function blankLine(overrides: Partial<Omit<LineDraft, 'key'>> = {}): LineDraft {
  seq += 1;
  return {
    key: `line-${String(seq)}`,
    productId: '',
    description: '',
    qty: '1',
    unitPrice: '0.00',
    discount: '0',
    taxId: '',
    ...overrides,
  };
}

/** Parses a typed currency amount into integer cents. Never returns NaN. */
export function parseMoney(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Parses a typed quantity into integer milli. Never returns NaN. */
export function parseQty(raw: string): number {
  const cleaned = raw.replace(/[^0-9.-]/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000);
}

/** Parses a typed percentage into basis points. */
function parsePercent(raw: string): number {
  const value = Number(raw.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/** Money for display. Presentation only. */
function display(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Converts the typed grid into the exact payload shape the server declares.
 *
 * Rows with no description and no product are dropped rather than sent as a
 * validation error — an operator who clicks "add line" and then changes their
 * mind should not have to delete the empty row to save.
 */
export function toLineInputs(rows: readonly LineDraft[], showDiscount = false): SaleLineInput[] {
  return rows
    .filter((row) => row.description.trim().length > 0 || row.productId.length > 0)
    .map((row) => {
      const line: SaleLineInput = {
        description: row.description.trim() || 'Item',
        qtyMilli: parseQty(row.qty),
        unitPriceCents: parseMoney(row.unitPrice),
      };
      return {
        ...line,
        ...(row.productId ? { productId: row.productId } : {}),
        ...(showDiscount && parsePercent(row.discount) > 0 ? { discountBp: parsePercent(row.discount) } : {}),
        ...(row.taxId ? { taxId: row.taxId } : {}),
      };
    });
}

/** The purchase-order flavour: no discount column, so the payload stays exact. */
export function toPoLineInputs(rows: readonly LineDraft[]): PoLineInput[] {
  return rows
    .filter((row) => row.description.trim().length > 0 || row.productId.length > 0)
    .map((row) => ({
      description: row.description.trim() || 'Item',
      qtyMilli: parseQty(row.qty),
      unitPriceCents: parseMoney(row.unitPrice),
      ...(row.productId ? { productId: row.productId } : {}),
      ...(row.taxId ? { taxId: row.taxId } : {}),
    }));
}

export function LineGrid({
  rows,
  onChange,
  products,
  taxes,
  currency,
  showDiscount = false,
  showTax = true,
  readOnly = false,
  renderQty,
  footerNote,
  error,
}: LineGridProps): JSX.Element {
  const totals = useMemo(() => {
    let net = 0;
    for (const row of rows) {
      const qty = parseQty(row.qty);
      const price = parseMoney(row.unitPrice);
      const discount = showDiscount ? parsePercent(row.discount) : 0;
      // Integer maths, mirroring the server: qty(milli) × price(cents) / 1000,
      // then the discount in basis points off the top.
      const lineNet = Math.round((qty * price) / 1000);
      net += lineNet - Math.round((lineNet * discount) / 10_000);
    }
    return net;
  }, [rows, showDiscount]);

  const update = (index: number, patch: Partial<LineDraft>): void => {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full border-collapse text-body" aria-label="Document lines">
          <thead>
            <tr className="bg-surface-2 text-meta text-muted">
              <th scope="col" className="w-8 px-2 py-1.5 text-left font-medium">#</th>
              <th scope="col" className="px-2 py-1.5 text-left font-medium">Item</th>
              <th scope="col" className="w-64 px-2 py-1.5 text-left font-medium">Product</th>
              <th scope="col" className="w-24 px-2 py-1.5 text-right font-medium">Qty</th>
              <th scope="col" className="w-28 px-2 py-1.5 text-right font-medium">Unit price</th>
              {showDiscount ? (
                <th scope="col" className="w-20 px-2 py-1.5 text-right font-medium">Disc %</th>
              ) : null}
              {showTax ? (
                <th scope="col" className="w-40 px-2 py-1.5 text-left font-medium">Tax</th>
              ) : null}
              <th scope="col" className="w-32 px-2 py-1.5 text-right font-medium">Net</th>
              <th scope="col" className="w-10 px-1 py-1.5">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const qty = parseQty(row.qty);
              const price = parseMoney(row.unitPrice);
              const discount = showDiscount ? parsePercent(row.discount) : 0;
              const gross = Math.round((qty * price) / 1000);
              const net = gross - Math.round((gross * discount) / 10_000);
              return (
                <tr key={row.key} className="border-t border-line">
                  <td className="px-2 py-1 text-meta text-muted">{index + 1}</td>
                  <td className="px-2 py-1">
                    <Input
                      aria-label={`Description for line ${String(index + 1)}`}
                      value={row.description}
                      disabled={readOnly}
                      placeholder="What is being bought or sold"
                      onChange={(event) => update(index, { description: event.target.value })}
                      className="h-7"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <Select
                      aria-label={`Product for line ${String(index + 1)}`}
                      value={row.productId}
                      disabled={readOnly}
                      options={[{ value: '', label: 'No product' }, ...products]}
                      onChange={(event) => {
                        const productId = event.target.value;
                        const label = products.find((option) => option.value === productId)?.label ?? '';
                        update(index, {
                          productId,
                          // Filling the description from the product is a
                          // courtesy, not a rule: if the operator already typed
                          // one, theirs wins.
                          description: row.description.trim() === '' ? label : row.description,
                        });
                      }}
                      className="h-7"
                    />
                  </td>
                  <td className="px-2 py-1">
                    {renderQty ? (
                      renderQty(row, index, (value) => update(index, { qty: value }))
                    ) : (
                      <Input
                        aria-label={`Quantity for line ${String(index + 1)}`}
                        inputMode="decimal"
                        value={row.qty}
                        disabled={readOnly}
                        onChange={(event) => update(index, { qty: event.target.value })}
                        className="h-7 text-right tnum"
                      />
                    )}
                  </td>
                  <td className="px-2 py-1">
                    <Input
                      aria-label={`Unit price for line ${String(index + 1)}`}
                      inputMode="decimal"
                      value={row.unitPrice}
                      disabled={readOnly}
                      onChange={(event) => update(index, { unitPrice: event.target.value })}
                      className="h-7 text-right tnum"
                    />
                  </td>
                  {showDiscount ? (
                    <td className="px-2 py-1">
                      <Input
                        aria-label={`Discount for line ${String(index + 1)}`}
                        inputMode="decimal"
                        value={row.discount}
                        disabled={readOnly}
                        onChange={(event) => update(index, { discount: event.target.value })}
                        className="h-7 text-right tnum"
                      />
                    </td>
                  ) : null}
                  {showTax ? (
                    <td className="px-2 py-1">
                      <Select
                        aria-label={`Tax for line ${String(index + 1)}`}
                        value={row.taxId}
                        disabled={readOnly}
                        options={[{ value: '', label: 'No tax' }, ...taxes]}
                        onChange={(event) => update(index, { taxId: event.target.value })}
                        className="h-7"
                      />
                    </td>
                  ) : null}
                  <td className="tnum px-2 py-1 text-right text-text">{display(net, currency)}</td>
                  <td className="px-1 py-1 text-right">
                    {readOnly ? null : (
                      <Tooltip label="Remove line">
                        <IconButton
                          label={`Remove line ${String(index + 1)}`}
                          size="sm"
                          onClick={() => onChange(rows.filter((_, position) => position !== index))}
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={showDiscount ? (showTax ? 9 : 8) : showTax ? 8 : 7} className="px-3 py-6 text-center text-meta text-muted">
                  No lines yet — add one to start.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot>
            <tr className="border-t border-line bg-surface-2">
              <td colSpan={showDiscount ? (showTax ? 7 : 6) : showTax ? 6 : 5} className="px-2 py-1.5 text-right text-meta text-muted">
                Net total
              </td>
              <td className="tnum px-2 py-1.5 text-right text-body font-medium text-text">{display(totals, currency)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex items-center justify-between gap-2">
        {readOnly ? (
          <span className="text-meta text-muted">{footerNote ?? ''}</span>
        ) : (
          <Button size="sm" variant="ghost" iconLeft={<Plus size={13} />} onClick={() => onChange([...rows, blankLine()])}>
            Add line
          </Button>
        )}
        <span className="text-meta text-muted">{footerNote ?? 'Tax and document total are computed by the server on save.'}</span>
      </div>

      {error !== null && error !== undefined ? (
        <p role="alert" className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
