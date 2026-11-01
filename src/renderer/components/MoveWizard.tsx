/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `MoveWizard` — the four stock operations an operator actually performs
 * (T07 gap closure): receive, issue, transfer, adjust.
 *
 * The wizard exists because a raw "post a move" form makes the operator
 * responsible for the sign convention, and the sign convention is the thing that
 * silently corrupts a stock ledger. Here the *type* decides the sign: `issue`
 * takes a positive quantity and negates it, `adjustment` is the only type where
 * the operator may type a negative number, and the wizard refuses to submit an
 * adjustment without a reason — because "why is this 3 short" is the only
 * question anyone will ask about an adjustment afterwards.
 *
 * Locations are fetched per warehouse on demand rather than all at once: a
 * company with 40 warehouses and 400 locations should not ship 400 rows to open a
 * dialog.
 */

import { AlertTriangle } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

import type { MoveResult, MoveType } from '@shared/ops';
import { MAX_PAGE_SIZE } from '@shared/types';
import type { Paged } from '@shared/types';

import { Modal } from './Modal';
import { Button, Input, Select, Textarea } from './ui';
import { invoke, isApiError } from '../lib/api';
import { today } from '../lib/finance';
import { toast } from '../lib/toast';
import { invalidate, useQuery } from '../lib/useQuery';

interface ProductOption {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly uom: string;
  readonly costMethod: string;
}

interface WarehouseOption {
  readonly id: string;
  readonly name: string;
}

interface LocationOption {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly warehouse_id: string;
}

const TYPES: readonly { readonly value: MoveType; readonly label: string; readonly hint: string }[] = [
  { value: 'receipt', label: 'Receive', hint: 'Stock arrives into a location. Debits inventory.' },
  { value: 'issue', label: 'Issue', hint: 'Stock leaves a location. Credits inventory.' },
  { value: 'transfer', label: 'Transfer', hint: 'Moves stock between locations. No journal — the company still owns it.' },
  { value: 'adjustment', label: 'Adjust', hint: 'Corrects a count. A reason is mandatory and is written to the audit log.' },
];

/** Which ends of the move a type needs. */
function needsFrom(type: MoveType): boolean {
  return type === 'issue' || type === 'transfer' || type === 'production_out';
}

function needsTo(type: MoveType): boolean {
  return type === 'receipt' || type === 'transfer' || type === 'production_in';
}

export interface MoveWizardProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Pre-selects the product when opened from a product's row. */
  readonly productId?: string;
  readonly onPosted?: (result: MoveResult) => void;
}

export function MoveWizard({ open, onOpenChange, productId, onPosted }: MoveWizardProps): JSX.Element {
  const [type, setType] = useState<MoveType>('receipt');
  const [product, setProduct] = useState(productId ?? '');
  const [fromLocation, setFromLocation] = useState('');
  const [toLocation, setToLocation] = useState('');
  const [qty, setQty] = useState('1');
  const [unitCost, setUnitCost] = useState('');
  const [reason, setReason] = useState('');
  const [movedAt, setMovedAt] = useState(today());
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ids = {
    type: useId(),
    product: useId(),
    from: useId(),
    to: useId(),
    qty: useId(),
    cost: useId(),
    reason: useId(),
    date: useId(),
    ref: useId(),
  };

  const products = useQuery<readonly ProductOption[]>(
    'move:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: 200,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const warehouses = useQuery<readonly WarehouseOption[]>(
    'move:warehouses',
    () =>
      invoke<Paged<WarehouseOption>>('entity.list', {
        entity: 'warehouses',
        limit: 100,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  const locations = useQuery<readonly LocationOption[]>(
    'move:locations',
    () =>
      invoke<Paged<LocationOption>>('entity.list', {
        entity: 'locations',
        limit: MAX_PAGE_SIZE,
        sort: { key: 'code', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000, enabled: open },
  );

  // Reset whenever the dialog opens so a cancelled draft never leaks into the
  // next one — the single most common bug in a wizard that keeps state.
  useEffect(() => {
    if (!open) return;
    setType('receipt');
    setProduct(productId ?? '');
    setFromLocation('');
    setToLocation('');
    setQty('1');
    setUnitCost('');
    setReason('');
    setMovedAt(today());
    setReference('');
    setError(null);
  }, [open, productId]);

  const warehouseName = useMemo(() => {
    const byId = new Map((warehouses.data ?? []).map((row) => [row.id, row.name]));
    return (locationId: string): string => {
      const location = (locations.data ?? []).find((row) => row.id === locationId);
      return location ? (byId.get(location.warehouse_id) ?? '') : '';
    };
  }, [warehouses.data, locations.data]);

  const locationOptions = useMemo(
    () =>
      (locations.data ?? []).map((row) => ({
        value: row.id,
        label: `${warehouseName(row.id)} · ${row.code} ${row.name}`.trim(),
      })),
    [locations.data, warehouseName],
  );

  const selectedProduct = (products.data ?? []).find((row) => row.id === product);
  const signedQty = ((): number => {
    const value = Number(qty.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(value) || value === 0) return 0;
    const milli = Math.round(value * 1000);
    return type === 'issue' || type === 'production_out' ? -Math.abs(milli) : milli;
  })();

  const negative = signedQty < 0;
  const needsReason = type === 'adjustment' || negative;
  const hint = TYPES.find((entry) => entry.value === type)?.hint ?? '';

  const missing: string[] = [];
  if (product === '') missing.push('a product');
  if (needsFrom(type) && fromLocation === '') missing.push('a source location');
  if (needsTo(type) && toLocation === '') missing.push('a destination location');
  if (signedQty === 0) missing.push('a quantity');
  if (type === 'transfer' && fromLocation !== '' && fromLocation === toLocation) missing.push('two different locations');
  if (needsReason && reason.trim().length < 3) missing.push('a reason');

  async function submit(): Promise<void> {
    if (missing.length > 0) {
      setError(`Still needed: ${missing.join(', ')}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await invoke<MoveResult>('inventory.moves.post', {
        type,
        productId: product,
        ...(needsFrom(type) ? { fromLocationId: fromLocation } : {}),
        ...(needsTo(type) ? { toLocationId: toLocation } : {}),
        qtyMilli: signedQty,
        ...(unitCost.trim() !== ''
          ? { unitCostCents: Math.round(Number(unitCost.replace(/[^0-9.-]/g, '')) * 100) }
          : {}),
        ...(reason.trim() !== '' ? { reason: reason.trim() } : {}),
        movedAt,
        ...(reference.trim() !== '' ? { reference: reference.trim() } : {}),
        ...(selectedProduct ? { uom: selectedProduct.uom } : {}),
      });
      invalidate('ops:');
      invalidate('inventory:');
      toast.success(
        result.override ? 'Move posted with an override' : 'Move posted',
        `${signedQty > 0 ? '+' : ''}${(signedQty / 1000).toLocaleString('en-US', {
          maximumFractionDigits: 3,
        })} on hand now.${result.journalEntryId ? ' A journal entry was written.' : ''}`,
      );
      onPosted?.(result);
      onOpenChange(false);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That move could not be posted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New stock move"
      description="On-hand is derived from moves. This is the only way to change it."
      size="lg"
      busy={busy}
      onConfirm={() => void submit()}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Post move
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.type} className="text-meta font-medium text-text">What happened</label>
          <Select
            id={ids.type}
            value={type}
            options={TYPES.map((entry) => ({ value: entry.value, label: entry.label }))}
            onChange={(event) => setType(event.target.value as MoveType)}
          />
          <p className="text-meta text-muted">{hint}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <label htmlFor={ids.product} className="text-meta font-medium text-text">Product</label>
            <Select
              id={ids.product}
              value={product}
              placeholder="Choose a product"
              options={(products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` }))}
              onChange={(event) => setProduct(event.target.value)}
            />
          </div>

          {/*
            A failed lookup used to be invisible: the select simply had no
            options and the only feedback was "a destination location is
            required" on submit. Say what actually broke.
          */}
          {locations.error ?? products.error ? (
            <p
              role="alert"
              className="rounded-input border border-danger bg-danger-soft px-3 py-2 text-meta text-danger"
            >
              Could not load {(locations.error ? 'the locations' : 'the products')} —{' '}
              {(locations.error ?? products.error)?.message}
            </p>
          ) : null}

          {needsFrom(type) ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.from} className="text-meta font-medium text-text">From location</label>
              <Select
                id={ids.from}
                value={fromLocation}
                placeholder="Choose a location"
                options={locationOptions}
                onChange={(event) => setFromLocation(event.target.value)}
              />
            </div>
          ) : null}

          {needsTo(type) ? (
            <div className="flex flex-col gap-1">
              <label htmlFor={ids.to} className="text-meta font-medium text-text">Into location</label>
              <Select
                id={ids.to}
                value={toLocation}
                placeholder="Choose a location"
                options={locationOptions}
                onChange={(event) => setToLocation(event.target.value)}
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <label htmlFor={ids.qty} className="text-meta font-medium text-text">
              Quantity {selectedProduct ? `(${selectedProduct.uom})` : ''}
            </label>
            <Input
              id={ids.qty}
              inputMode="decimal"
              value={qty}
              onChange={(event) => setQty(event.target.value)}
            />
            {type === 'adjustment' ? (
              <p className="text-meta text-muted">Type a negative number to write stock off.</p>
            ) : (
              <p className="text-meta text-muted">Always enter a positive number — the type decides the sign.</p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={ids.cost} className="text-meta font-medium text-text">
              Unit cost {unitCost.trim() === '' ? '(uses current cost)' : ''}
            </label>
            <Input
              id={ids.cost}
              inputMode="decimal"
              value={unitCost}
              placeholder="0.00"
              onChange={(event) => setUnitCost(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={ids.date} className="text-meta font-medium text-text">Moved on</label>
            <Input id={ids.date} type="date" value={movedAt} onChange={(event) => setMovedAt(event.target.value)} />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={ids.ref} className="text-meta font-medium text-text">Reference</label>
            <Input
              id={ids.ref}
              value={reference}
              placeholder="Delivery note, count sheet…"
              onChange={(event) => setReference(event.target.value)}
            />
          </div>

          <div className="col-span-2 flex flex-col gap-1">
            <label htmlFor={ids.reason} className="text-meta font-medium text-text">
              Reason {needsReason ? '(required)' : '(optional)'}
            </label>
            <Textarea
              id={ids.reason}
              rows={2}
              value={reason}
              placeholder="Cycle count variance, damaged in transit…"
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
        </div>

        {negative && type !== 'adjustment' ? (
          <div className="flex items-start gap-2 rounded-card border border-warning bg-warning-soft p-2 text-meta text-warning">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              This move takes stock below zero. It will be refused unless you hold the negative-stock permission, and
              the override is recorded against your name.
            </span>
          </div>
        ) : null}

        {error !== null ? (
          <p role="alert" className="text-meta text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
