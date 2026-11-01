/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Warehouses and their locations (T07, gap closure).
 *
 * One list, because a location only means something inside a warehouse — splitting
 * them into two screens makes an operator click twice to answer "where can I put
 * this".
 *
 * Both records are now creatable and editable in place. Locations are added from
 * the warehouse drawer rather than from a separate screen, and the form is
 * pre-seeded with `warehouse_id` so a location can never be created orphaned —
 * which the schema would refuse anyway, but only after the operator had filled in
 * the whole form.
 */

import { MapPin, Plus } from 'lucide-react';
import { useCallback, useState } from 'react';

import type { Paged } from '@shared/types';

import { Drawer } from '../../components/Drawer';
import { OpsTable, type OpsColumn } from '../../components/OpsTable';
import { RecordFormModal, type RecordField } from '../../components/RecordForm';
import { Button, Chip } from '../../components/ui';
import { invoke } from '../../lib/api';
import { useNewParam } from '../../lib/useNewParam';
import { useSession } from '../../store';

interface LocationRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_active?: number;
}

interface WarehouseRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_active: number;
  readonly locations?: readonly LocationRow[];
}

const WAREHOUSE_FIELDS: readonly RecordField[] = [
  { key: 'code', label: 'Code', kind: 'text', required: true, placeholder: 'MAIN', help: 'Short, stable, and used on every move.' },
  { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Main warehouse' },
  { key: 'address', label: 'Address', kind: 'textarea', span: 2 },
  { key: 'is_active', label: 'Active', kind: 'checkbox', help: 'Active — selectable when posting a move' },
];

const LOCATION_FIELDS: readonly RecordField[] = [
  { key: 'code', label: 'Code', kind: 'text', required: true, placeholder: 'A-01' },
  { key: 'name', label: 'Name', kind: 'text', required: true, placeholder: 'Aisle 1' },
  { key: 'is_active', label: 'Active', kind: 'checkbox', help: 'Active — selectable when posting a move' },
];

/**
 * Locations are fetched per visible warehouse rather than joined.
 *
 * One extra query per row is bounded by the page size (50), and it keeps the
 * response small no matter how many locations a company has — the alternative,
 * returning every location with every warehouse, is how a "simple" list screen
 * ends up sending 20 000 rows.
 */
async function withLocations(warehouses: readonly WarehouseRow[]): Promise<WarehouseRow[]> {
  return Promise.all(
    warehouses.map(async (warehouse) => {
      try {
        const locations = await invoke<Paged<LocationRow>>('entity.list', {
          entity: 'locations',
          filters: { warehouse_id: warehouse.id },
          sort: { key: 'code', dir: 'asc' },
          limit: 50,
          offset: 0,
        });
        return { ...warehouse, locations: locations.rows };
      } catch {
        return warehouse;
      }
    }),
  );
}

export function Warehouses(): JSX.Element {
  const canWrite = useSession((state) => state.can('inventory.warehouse.write'));
  const [editing, setEditing] = useState<WarehouseRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [peek, setPeek] = useState<WarehouseRow | null>(null);
  const [locationFor, setLocationFor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useNewParam(() => {
    setEditing(null);
    setFormOpen(true);
  });

  const fetcher = useCallback(
    async ({ page, pageSize, q }: { page: number; pageSize: number; q?: string }) => {
      const result = await invoke<Paged<WarehouseRow>>('entity.list', {
        entity: 'warehouses',
        q,
        sort: { key: 'name', dir: 'asc' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      return { rows: await withLocations(result.rows), total: result.total };
    },
    // `reload` is a dependency so a new location shows up without a page refresh.
    [reload],
  );

  const COLUMNS: readonly OpsColumn<WarehouseRow>[] = [
    { key: 'code', label: 'Code', width: 'w-28', render: (row) => <span className="font-mono text-meta">{row.code}</span> },
    { key: 'name', label: 'Warehouse', render: (row) => <span className="text-text">{row.name}</span> },
    {
      key: 'locations',
      label: 'Locations',
      render: (row) => {
        const locations = row.locations ?? [];
        if (locations.length === 0) return <span className="text-muted">No locations yet</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {locations.map((location) => (
              <span key={location.id} className="rounded-chip bg-surface-2 px-2 py-0.5 text-meta text-muted">
                {location.code} · {location.name}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: 'active',
      label: 'Status',
      width: 'w-24',
      render: (row) => (Number(row.is_active) === 1 ? 'Active' : 'Archived'),
    },
  ];

  const warehouseLocations = peek?.locations ?? [];

  return (
    <>
      <OpsTable<WarehouseRow>
        title="Warehouses"
        subtitle="Stock lives in a location, and every move names one."
        countLabel="warehouses"
        queryKey={`ops:warehouses:${String(reload)}`}
        fetcher={fetcher}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        searchPlaceholder="Search warehouse"
        emptyTitle="No warehouses yet"
        emptyHint="Create a warehouse and at least one location before receiving stock."
        primaryAction={
          canWrite ? (
            <Button
              variant="primary"
              iconLeft={<Plus size={14} />}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              New warehouse
            </Button>
          ) : null
        }
        onRowClick={(row) => setPeek(row)}
      />

      <RecordFormModal
        open={formOpen}
        onOpenChange={setFormOpen}
        entity="warehouses"
        title="Warehouse"
        description="A warehouse groups locations. Every stock move names one location inside one warehouse."
        fields={WAREHOUSE_FIELDS}
        initial={editing}
        defaults={{ is_active: 1 }}
        invalidatePrefixes={['ops:', 'move:']}
        onSaved={() => setReload((value) => value + 1)}
      />

      <RecordFormModal
        open={locationFor !== null}
        onOpenChange={(open) => (open ? undefined : setLocationFor(null))}
        entity="locations"
        title="Location"
        description="A shelf, a bin, a bay. This is the thing a move actually names."
        fields={LOCATION_FIELDS}
        defaults={{ warehouse_id: locationFor ?? undefined, is_active: 1 }}
        invalidatePrefixes={['ops:', 'move:']}
        onSaved={() => {
          setLocationFor(null);
          setPeek(null);
          setReload((value) => value + 1);
        }}
      />

      <Drawer
        open={peek !== null}
        onOpenChange={(open) => (open ? undefined : setPeek(null))}
        title={peek ? `${peek.code} · ${peek.name}` : ''}
        subtitle={peek ? `${String(warehouseLocations.length)} location${warehouseLocations.length === 1 ? '' : 's'}` : undefined}
        width={520}
        footer={
          peek ? (
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={() => setPeek(null)}>
                Close
              </Button>
              <div className="flex gap-2">
                {canWrite ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    iconLeft={<Plus size={13} />}
                    onClick={() => setLocationFor(peek.id)}
                  >
                    Add location
                  </Button>
                ) : null}
                {canWrite ? (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => {
                      setEditing(peek);
                      setPeek(null);
                      setFormOpen(true);
                    }}
                  >
                    Edit warehouse
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null
        }
      >
        {peek ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Chip tone={Number(peek.is_active) === 1 ? 'success' : 'neutral'}>
                {Number(peek.is_active) === 1 ? 'Active' : 'Archived'}
              </Chip>
              <span className="text-meta text-muted">Code {peek.code}</span>
            </div>

            {warehouseLocations.length === 0 ? (
              <p className="rounded-card border border-line bg-surface-2 p-3 text-meta text-muted">
                <MapPin size={13} className="mr-1 inline" aria-hidden="true" />
                No locations yet. Stock cannot be received until this warehouse has at least one.
              </p>
            ) : (
              <ul className="divide-y divide-line rounded-card border border-line">
                {warehouseLocations.map((location) => (
                  <li key={location.id} className="flex items-center justify-between px-3 py-2">
                    <span className="text-body text-text">{location.name}</span>
                    <span className="font-mono text-meta text-muted">{location.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
