/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Price lists — list and editor (T08, US-36, BR-17, gap closure).
 *
 * The expiry is shown, not hidden: an expired list silently stops being used, and
 * an operator who cannot see the date will spend an hour wondering why a customer
 * is being quoted list price.
 *
 * Resolution order is printed on the screen because it is the thing that makes a
 * price list comprehensible: contract → customer list → default list → the
 * product's list price. The editor therefore cannot set a "priority" — there is
 * nothing to set, the order is structural.
 */

import { ArrowLeft, Plus, Save, Star, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { PriceListDetail, PriceListRow } from '@shared/ops';
import { MAX_PAGE_SIZE } from '@shared/types';
import type { Paged } from '@shared/types';

import { OpsTable, money, type OpsColumn } from '../../components/OpsTable';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, SectionCard, TableSkeleton } from '../../components/patterns';
import { Button, Checkbox, Chip, IconButton, Input, Select, Tooltip } from '../../components/ui';
import { invoke, isApiError } from '../../lib/api';
import { toast } from '../../lib/toast';
import { invalidate, useQuery } from '../../lib/useQuery';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface ProductOption {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly base_price_cents: number;
}

/** One editable item row. Price is text while typing. */
interface ItemDraft {
  readonly key: string;
  productId: string;
  price: string;
  minQty: string;
}

let itemSeq = 0;

function blankItem(): ItemDraft {
  itemSeq += 1;
  return { key: `item-${String(itemSeq)}`, productId: '', price: '0.00', minQty: '1' };
}

const COLUMNS: readonly OpsColumn<PriceListRow>[] = [
  { key: 'name', label: 'List', render: (row) => <span className="text-text">{row.name}</span> },
  { key: 'currency', label: 'Currency', width: 'w-24', render: (row) => row.currency },
  { key: 'from', label: 'Valid from', width: 'w-32', render: (row) => (row.validFrom ? row.validFrom : 'Always') },
  {
    key: 'to',
    label: 'Valid to',
    width: 'w-32',
    render: (row) => (row.isExpired ? <span className="text-danger">{row.validTo}</span> : (row.validTo ?? 'Open')),
  },
  { key: 'items', label: 'Items', align: 'right', width: 'w-24', render: (row) => String(row.itemCount) },
  {
    key: 'state',
    label: 'Status',
    width: 'w-32',
    render: (row) => (
      <span className="text-muted">
        {row.isDefault ? 'Default' : row.isActive ? 'Active' : 'Inactive'}
        {row.isExpired ? ' · expired' : ''}
      </span>
    ),
  },
];

export function PriceLists(): JSX.Element {
  const canManage = useSession((state) => state.can('sales.pricelist.manage'));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reload, setReload] = useState(0);
  useNewParam(() => setCreating(true));

  const fetcher = useCallback(
    async ({ page, pageSize }: { page: number; pageSize: number }) => {
      const rows = await invoke<readonly PriceListRow[]>('sales.pricelist.list', {});
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
    },
    [reload],
  );

  if (creating || editingId !== null) {
    return (
      <PriceListEditor
        id={editingId}
        onBack={() => {
          setEditingId(null);
          setCreating(false);
          setReload((value) => value + 1);
        }}
      />
    );
  }

  return (
    <OpsTable<PriceListRow>
      title="Price lists"
      subtitle="Resolution: contract → customer list → default list → list price."
      countLabel="lists"
      queryKey={`ops:pricelists:${String(reload)}`}
      fetcher={fetcher}
      columns={COLUMNS}
      rowKey={(row) => row.id}
      emptyTitle="No price lists"
      emptyHint="Create a default list so products have a price to fall back to."
      primaryAction={
        canManage ? (
          <Button variant="primary" iconLeft={<Plus size={14} />} onClick={() => setCreating(true)}>
            New price list
          </Button>
        ) : null
      }
      onRowClick={(row) => setEditingId(row.id)}
    />
  );
}

// ── editor ───────────────────────────────────────────────────────────────────

interface PriceListEditorProps {
  readonly id: string | null;
  readonly onBack: () => void;
}

function PriceListEditor({ id, onBack }: PriceListEditorProps): JSX.Element {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [validFrom, setValidFrom] = useState('');
  const [validTo, setValidTo] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [isActive, setIsActive] = useState(true);
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);

  const list = useQuery<PriceListDetail | null>(
    `pricelist:${id ?? 'new'}`,
    () => (id ? invoke<PriceListDetail>('sales.pricelist.items', { id }) : Promise.resolve(null)),
    { staleMs: 5_000, enabled: id !== null },
  );

  const products = useQuery<readonly ProductOption[]>(
    'pricelist:products',
    () =>
      invoke<Paged<ProductOption>>('entity.list', {
        entity: 'products',
        limit: MAX_PAGE_SIZE,
        sort: { key: 'name', dir: 'asc' },
      }).then((page) => page.rows),
    { staleMs: 60_000 },
  );

  const data = list.data;
  useEffect(() => {
    if (!data || seeded) return;
    setSeeded(true);
    setName(data.name);
    setCurrency(data.currency);
    setValidFrom(data.validFrom ?? '');
    setValidTo(data.validTo ?? '');
    setIsDefault(data.isDefault);
    setIsActive(data.isActive);
    setItems(
      data.items.map((item) => {
        itemSeq += 1;
        return {
          key: `item-${String(itemSeq)}`,
          productId: item.productId,
          price: (item.priceCents / 100).toFixed(2),
          minQty: String(item.minQtyMilli / 1000),
        };
      }),
    );
  }, [data, seeded]);

  const productOptions = useMemo(
    () => (products.data ?? []).map((row) => ({ value: row.id, label: `${row.sku} · ${row.name}` })),
    [products.data],
  );

  const byId = useMemo(() => new Map((products.data ?? []).map((row) => [row.id, row])), [products.data]);

  const payloadItems = items
    .filter((item) => item.productId !== '')
    .map((item) => ({
      productId: item.productId,
      priceCents: Math.round(Number(item.price.replace(/[^0-9.-]/g, '') || '0') * 100),
      minQtyMilli: Math.round(Number(item.minQty.replace(/[^0-9.-]/g, '') || '1') * 1000),
    }));

  async function save(): Promise<void> {
    if (name.trim().length === 0) {
      setError('Give the price list a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await invoke<PriceListDetail>('sales.pricelist.saveItems', {
        ...(id ? { id } : {}),
        name: name.trim(),
        currency,
        ...(validFrom ? { validFrom } : {}),
        ...(validTo ? { validTo } : {}),
        isDefault,
        isActive,
        items: payloadItems,
      });
      invalidate('ops:');
      toast.success('Price list saved', `${String(saved.items.length)} item${saved.items.length === 1 ? '' : 's'}${saved.isDefault ? ' · now the default list' : ''}.`);
      onBack();
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : 'That price list could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  const update = (index: number, patch: Partial<ItemDraft>): void => {
    setItems((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  };

  if (id !== null && list.loading && !data) {
    return (
      <div className="p-6">
        <TableSkeleton rows={6} columns={4} />
      </div>
    );
  }

  if (id !== null && !data && list.error) {
    return (
      <div className="p-6">
        <EmptyState
          title="That price list could not be loaded"
          description={list.error.message}
          action={
            <Button variant="secondary" onClick={onBack}>
              Back to price lists
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={id === null ? 'New price list' : `Edit ${name || 'price list'}`}
        subtitle="A price list is a set of overrides. Anything not listed falls through to the product's list price."
        secondaryActions={
          <Button variant="ghost" iconLeft={<ArrowLeft size={14} />} onClick={onBack}>
            Back
          </Button>
        }
        primaryAction={
          <Button variant="primary" loading={busy} iconLeft={<Save size={14} />} onClick={() => void save()}>
            Save list
          </Button>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <SectionCard title="Details" description="Dates are inclusive. Leave them blank for a list that never expires.">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Wholesale 2026" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Currency</span>
                <Select
                  aria-label="Currency"
                  value={currency}
                  options={[
                    { value: 'USD', label: 'USD' },
                    { value: 'EUR', label: 'EUR' },
                    { value: 'GBP', label: 'GBP' },
                  ]}
                  onChange={(event) => setCurrency(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Valid from</span>
                <Input type="date" value={validFrom} onChange={(event) => setValidFrom(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-meta font-medium text-text">Valid to</span>
                <Input type="date" value={validTo} onChange={(event) => setValidTo(event.target.value)} />
              </label>
              <Checkbox
                checked={isDefault}
                onChange={(event) => setIsDefault(event.target.checked)}
                label="Default — used when a customer has no list of their own"
              />
              <Checkbox
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
                label="Active — eligible for resolution"
              />
              {isDefault ? (
                <p className="text-meta text-muted">
                  <Star size={12} className="mr-1 inline" aria-hidden="true" />
                  There is only ever one default: saving this clears the flag on any other list.
                </p>
              ) : null}
            </div>
          </SectionCard>

          <SectionCard
            title="Prices"
            description="One row per product. A minimum quantity lets the same product carry a volume price."
          >
            <table className="w-full border-collapse text-body" aria-label="Price list items">
              <thead>
                <tr className="bg-surface-2 text-meta text-muted">
                  <th scope="col" className="px-2 py-1.5 text-left font-medium">Product</th>
                  <th scope="col" className="w-32 px-2 py-1.5 text-right font-medium">Price</th>
                  <th scope="col" className="w-28 px-2 py-1.5 text-right font-medium">Min qty</th>
                  <th scope="col" className="w-32 px-2 py-1.5 text-right font-medium">List price</th>
                  <th scope="col" className="w-10 px-1 py-1.5">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item, index) => {
                  const product = byId.get(item.productId);
                  return (
                    <tr key={item.key} className="border-t border-line">
                      <td className="px-2 py-1">
                        <Select
                          aria-label={`Product for row ${String(index + 1)}`}
                          value={item.productId}
                          placeholder="Choose a product"
                          options={productOptions}
                          onChange={(event) => {
                            const productId = event.target.value;
                            const picked = byId.get(productId);
                            update(index, {
                              productId,
                              // A blank price means "same as list" — filling it in
                              // from the product is the only sensible default.
                              price:
                                item.price === '0.00' && picked
                                  ? (picked.base_price_cents / 100).toFixed(2)
                                  : item.price,
                            });
                          }}
                          className="h-7"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label={`Price for row ${String(index + 1)}`}
                          inputMode="decimal"
                          value={item.price}
                          onChange={(event) => update(index, { price: event.target.value })}
                          className="h-7 text-right tnum"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          aria-label={`Minimum quantity for row ${String(index + 1)}`}
                          inputMode="decimal"
                          value={item.minQty}
                          onChange={(event) => update(index, { minQty: event.target.value })}
                          className="h-7 text-right tnum"
                        />
                      </td>
                      <td className="tnum px-2 py-1 text-right text-muted">
                        {product ? money(product.base_price_cents) : '—'}
                      </td>
                      <td className="px-1 py-1 text-right">
                        <Tooltip label="Remove row">
                          <IconButton
                            label={`Remove row ${String(index + 1)}`}
                            size="sm"
                            onClick={() => setItems((current) => current.filter((_, position) => position !== index))}
                          >
                            <Trash2 size={12} aria-hidden="true" />
                          </IconButton>
                        </Tooltip>
                      </td>
                    </tr>
                  );
                })}
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-meta text-muted">
                      No prices yet — add a row, or save an empty list and fill it in later.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            <div className="mt-2 flex items-center justify-between">
              <Button size="sm" variant="ghost" iconLeft={<Plus size={13} />} onClick={() => setItems((current) => [...current, blankItem()])}>
                Add row
              </Button>
              <Chip tone="neutral">{payloadItems.length} priced</Chip>
            </div>

            {error !== null ? (
              <p role="alert" className="mt-2 text-meta text-danger">
                {error}
              </p>
            ) : null}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}
