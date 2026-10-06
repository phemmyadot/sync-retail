import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@sync-retail/shared';
import { useAuth } from '@/store/auth';
import { useCan } from '@/hooks/useOverride';
import { AppShell } from '@/components/layout/AppShell';
import { OverrideModal } from '@/components/OverrideModal';
import { Toaster } from '@/components/ui/Toaster';
import { LoginPage } from '@/features/auth/LoginPage';
import { PosTerminal } from '@/features/pos/PosTerminal';
import { CustomerDisplay } from '@/features/display/CustomerDisplay';
import { InventoryPage } from '@/features/inventory/InventoryPage';
import { ImportPage } from '@/features/inventory/ImportPage';
import { CustomersPage } from '@/features/customers/CustomersPage';
import { SalesHistoryPage } from '@/features/sales/SalesHistoryPage';
import { ReportsPage } from '@/features/reports/ReportsPage';
import { AdminPage } from '@/features/admin/AdminPage';
import { AuditPage } from '@/features/admin/AuditPage';

/** Renders children when the user has the permission (or any of a list). */
function Guard({ perm, children }: { perm: Permission | Permission[]; children: ReactNode }) {
  const can = useCan();
  const allowed = Array.isArray(perm) ? perm.some(can) : can(perm);
  return allowed ? children : <Navigate to="/pos" replace />;
}

export function App() {
  const token = useAuth((s) => s.token);

  return (
    <>
      <Routes>
        {/* The customer display never requires a login. */}
        <Route path="/display" element={<CustomerDisplay />} />
        {!token ? (
          <Route path="*" element={<LoginPage />} />
        ) : (
          <Route element={<AppShell />}>
            <Route path="/pos" element={<PosTerminal />} />
            <Route path="/sales" element={<SalesHistoryPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/inventory/import" element={<Guard perm="inventory:import"><ImportPage /></Guard>} />
            <Route path="/reports" element={<Guard perm="reports:read"><ReportsPage /></Guard>} />
            <Route path="/audit" element={<Guard perm="audit:read"><AuditPage /></Guard>} />
            <Route path="/settings" element={<Guard perm={['users:manage', 'settings:write', 'tax:manage', 'devices:manage']}><AdminPage /></Guard>} />
            <Route path="*" element={<Navigate to="/pos" replace />} />
          </Route>
        )}
      </Routes>
      {token && <OverrideModal />}
      <Toaster />
    </>
  );
}
