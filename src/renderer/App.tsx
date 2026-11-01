/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * `App` — the router, the bootstrap call and the guard chain (§E.1).
 *
 * Guards run in the documented order and never redirect in a loop:
 *   needsOnboarding → `/onboarding` · no session → `/login` ·
 *   module disabled → a "not in this build" page · missing permission → 403 panel.
 *
 * `HashRouter` because the packaged renderer is loaded from `file://`, where a
 * history-based router cannot resolve a deep link on reload.
 */

import { useEffect, useMemo, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';

import { moduleForRoute } from '@shared/modules';
import type { Permission } from '@shared/permissions';
import type { BootstrapResult } from '@shared/types';

import { AppShell } from './components/AppShell';
import { PermissionGate } from './components/PermissionGate';
import { Button, Spinner } from './components/ui';
import { invoke, isApiError } from './lib/api';
import { toast } from './lib/toast';
import { clearQueryCache } from './lib/useQuery';
import { Dashboard } from './pages/Dashboard';
import { CrmAccounts } from './pages/crm/Accounts';
import { CrmActivities } from './pages/crm/Activities';
import { CrmAnalytics } from './pages/crm/Analytics';
import { CrmDeals } from './pages/crm/Deals';
import { CrmLeads } from './pages/crm/Leads';
import { Login } from './pages/Login';
import { NotFound } from './pages/NotFound';
import { Onboarding } from './pages/Onboarding';
import { Placeholder } from './pages/Placeholder';
import { Accounts } from './pages/finance/Accounts';
import { Bills } from './pages/finance/Bills';
import { Invoices } from './pages/finance/Invoices';
import { Journals } from './pages/finance/Journals';
import { Payments } from './pages/finance/Payments';
import { Periods } from './pages/finance/Periods';
import { Reports } from './pages/finance/Reports';
import { Products } from './pages/inventory/Products';
import { Stock } from './pages/inventory/Stock';
import { Warehouses } from './pages/inventory/Warehouses';
import { PurchasingBills } from './pages/purchasing/Bills';
import { PurchaseOrders } from './pages/purchasing/Orders';
import { Receipts } from './pages/purchasing/Receipts';
import { Vendors } from './pages/purchasing/Vendors';
import { Customers } from './pages/sales/Customers';
import { SalesOrders } from './pages/sales/Orders';
import { PriceLists } from './pages/sales/PriceLists';
import { Quotations } from './pages/sales/Quotations';
import { Company } from './pages/settings/Company';
import { Data as DataSettings } from './pages/settings/Data';
import { People } from './pages/settings/People';
import { System } from './pages/settings/System';
import { useSession, useUi } from './store';

interface RouteSpec {
  readonly path: string;
  readonly element: JSX.Element;
  readonly permission?: Permission;
}

/** The routes that exist in this build. Everything else falls through to 404. */
const ROUTES: readonly RouteSpec[] = [
  { path: '/dashboard', element: <Dashboard />, permission: 'dashboard.read' },
  { path: '/search', element: <Placeholder title="Search" />, permission: 'search.read' },

  { path: '/finance/invoices', element: <Invoices />, permission: 'finance.invoice.read' },
  { path: '/finance/bills', element: <Bills />, permission: 'finance.bill.read' },
  { path: '/finance/payments', element: <Payments />, permission: 'finance.payment.read' },
  { path: '/finance/journal-entries', element: <Journals />, permission: 'finance.journal.read' },
  { path: '/finance/accounts', element: <Accounts />, permission: 'finance.account.read' },
  { path: '/finance/periods', element: <Periods />, permission: 'finance.period.read' },
  { path: '/finance/reports', element: <Reports />, permission: 'finance.report.read' },
  {
    path: '/finance/reports/trial-balance',
    element: <Reports />,
    permission: 'finance.report.read',
  },

  { path: '/inventory/products', element: <Products />, permission: 'inventory.product.read' },
  { path: '/inventory/stock', element: <Stock />, permission: 'inventory.stock.read' },
  /*
   * The move ledger and the on-hand grid are the same screen: an operator looking
   * at a balance immediately wants the moves behind it, and the Stock page offers
   * both rather than making them a navigation apart.
   */
  { path: '/inventory/moves', element: <Stock />, permission: 'inventory.stock.read' },
  { path: '/inventory/warehouses', element: <Warehouses />, permission: 'inventory.warehouse.read' },

  { path: '/purchasing/vendors', element: <Vendors />, permission: 'purchasing.vendor.read' },
  { path: '/purchasing/orders', element: <PurchaseOrders />, permission: 'purchasing.po.read' },
  { path: '/purchasing/receipts', element: <Receipts />, permission: 'purchasing.receipt.read' },
  { path: '/purchasing/bills', element: <PurchasingBills />, permission: 'finance.bill.read' },

  { path: '/sales/customers', element: <Customers />, permission: 'sales.customer.read' },
  { path: '/sales/quotations', element: <Quotations />, permission: 'sales.quotation.read' },
  { path: '/sales/orders', element: <SalesOrders />, permission: 'sales.order.read' },
  { path: '/sales/price-lists', element: <PriceLists />, permission: 'sales.pricelist.read' },

  { path: '/crm/deals', element: <CrmDeals />, permission: 'crm.deal.read' },
  { path: '/crm/accounts', element: <CrmAccounts />, permission: 'crm.account.read' },
  { path: '/crm/leads', element: <CrmLeads />, permission: 'crm.lead.read' },
  { path: '/crm/activities', element: <CrmActivities />, permission: 'crm.activity.read' },
  { path: '/crm/analytics', element: <CrmAnalytics />, permission: 'crm.analytics.read' },

  { path: '/settings/company', element: <Company />, permission: 'settings.company.read' },
  { path: '/settings/users', element: <People tab="users" />, permission: 'settings.user.read' },
  { path: '/settings/roles', element: <People tab="roles" />, permission: 'settings.role.read' },
  {
    path: '/settings/custom-fields',
    element: <DataSettings tab="fields" />,
    permission: 'settings.custom_field.read',
  },
  { path: '/settings/numbering', element: <DataSettings tab="numbering" />, permission: 'settings.numbering.read' },
  { path: '/settings/taxes', element: <DataSettings tab="taxes" />, permission: 'settings.tax.read' },
  { path: '/settings/currencies', element: <DataSettings tab="currencies" />, permission: 'settings.currency.read' },
  { path: '/settings/import', element: <DataSettings tab="import" />, permission: 'data.import' },
  { path: '/settings/license', element: <System tab="license" />, permission: 'settings.license.read' },
  { path: '/settings/audit-log', element: <System tab="audit" />, permission: 'settings.audit.read' },
  { path: '/settings/backup', element: <System tab="backup" />, permission: 'settings.backup.run' },
  { path: '/settings/security', element: <System tab="security" />, permission: 'settings.security.manage' },
  { path: '/settings/appearance', element: <System tab="appearance" />, permission: 'app.prefs.write' },
];

/** Rendered when a module is disabled by the active industry preset. */
function ModuleDisabled(): JSX.Element {
  return (
    <div className="p-8">
      <h1 className="text-[15px] font-semibold text-text">That area is not part of this company</h1>
      <p className="mt-1 max-w-lg text-meta text-muted">
        Your industry preset does not include this module. An administrator can change the preset in
        Settings → Data.
      </p>
    </div>
  );
}

/** Rendered when the signed-in role lacks the page's permission. */
function Forbidden({ permission }: { readonly permission: string }): JSX.Element {
  return (
    <div className="p-8">
      <h1 className="text-[15px] font-semibold text-text">You do not have access to this page</h1>
      <p className="mt-1 max-w-lg text-meta text-muted">
        This needs the <code className="tnum text-text">{permission}</code> permission. Ask an administrator to
        add it to your role.
      </p>
    </div>
  );
}

function Splash({ error, onRetry }: { readonly error: string | null; readonly onRetry: () => void }): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="flex flex-col items-center gap-3">
        {error ? (
          <>
            <p className="max-w-md text-center text-body text-text">{error}</p>
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <>
            <Spinner size={20} />
            <p className="text-meta text-muted">Starting NEXUS…</p>
          </>
        )}
      </div>
    </div>
  );
}

/** The guard: decides between onboarding, login and the shell. */
function GuardedRoutes(): JSX.Element {
  const location = useLocation();
  const ready = useSession((state) => state.ready);
  const needsOnboarding = useSession((state) => state.needsOnboarding);
  const user = useSession((state) => state.user);
  const modules = useSession((state) => state.modules);

  if (!ready) return <Splash error={null} onRetry={() => undefined} />;

  if (needsOnboarding) {
    return location.pathname === '/onboarding' ? <Onboarding /> : <Navigate to="/onboarding" replace />;
  }

  if (location.pathname === '/onboarding') return <Navigate to="/dashboard" replace />;

  if (!user) {
    return location.pathname === '/login' ? <Login /> : <Navigate to="/login" replace />;
  }

  if (location.pathname === '/login') return <Navigate to="/dashboard" replace />;

  const owner = moduleForRoute(location.pathname);
  if (owner && modules.length > 0 && !modules.includes(owner.id)) {
    return (
      <AppShell>
        <ModuleDisabled />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Routes>
        {ROUTES.map((route) => (
          <Route
            key={route.path}
            path={route.path}
            element={
              route.permission ? (
                <PermissionGate permission={route.permission} fallback={<Forbidden permission={route.permission} />}>
                  {route.element}
                </PermissionGate>
              ) : (
                route.element
              )
            }
          />
        ))}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}

export function App(): JSX.Element {
  const applyBootstrap = useSession((state) => state.applyBootstrap);
  const ready = useSession((state) => state.ready);
  const hydrateUi = useUi((state) => state.hydrate);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      try {
        const result = await invoke<BootstrapResult>('app.bootstrap', {});
        if (cancelled) return;
        applyBootstrap(result);
        hydrateUi(result.prefs);
        clearQueryCache();
        if (result.suspectClock) {
          toast.warning(
            'The system clock has moved backwards',
            'Licence dates are ignored, but check the machine clock. Work is unaffected.',
          );
        }
      } catch (caught) {
        if (cancelled) return;
        setError(
          isApiError(caught)
            ? caught.message
            : 'NEXUS could not start. Close the application and open it again.',
        );
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [applyBootstrap, hydrateUi, attempt]);

  const content = useMemo(() => {
    if (!ready) return <Splash error={error} onRetry={() => setAttempt((value) => value + 1)} />;
    return (
      <HashRouter>
        <GuardedRoutes />
      </HashRouter>
    );
  }, [ready, error]);

  return content;
}
