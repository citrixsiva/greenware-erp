import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth, useCan } from './lib/auth';
import { Shell } from './components/Shell';
import { EmptyState, LoadingState } from './components/ui';
import Login from './pages/Login';

const Pipeline = lazy(() => import('./pages/Pipeline'));
const Enquiries = lazy(() => import('./pages/Enquiries'));
const Enquiry360 = lazy(() => import('./pages/Enquiry360'));
const Procurement = lazy(() => import('./pages/Procurement'));
const ProcurementDetail = lazy(() => import('./pages/ProcurementDetail'));
const Estimation = lazy(() => import('./pages/Estimation'));
const EstimationDetail = lazy(() => import('./pages/EstimationDetail'));
const Quotations = lazy(() => import('./pages/Quotations'));
const QuotationBuilder = lazy(() => import('./pages/QuotationBuilder'));
const PriceHistory = lazy(() => import('./pages/PriceHistory'));
const Approvals = lazy(() => import('./pages/Approvals'));
const Admin = lazy(() => import('./pages/Admin'));

/** The route renders only if the user holds the permission; otherwise a plain explanation, never a blank page. */
function Gate({ perm, children }: { perm: string; children: ReactNode }) {
  const can = useCan(perm);
  if (!can) {
    return (
      <div className="panel">
        <EmptyState title="Not available to your role" hint={`This screen needs the “${perm}” permission. Ask an administrator if you should have it.`} />
      </div>
    );
  }
  return <>{children}</>;
}

function Home() {
  const { user } = useAuth();
  const order: [string, string][] = [
    ['enquiries.view', '/pipeline'],
    ['procurement_requests.view', '/procurement'],
    ['technical_estimations.view', '/estimation'],
    ['quotations.view', '/quotations'],
    ['price_history.view', '/price-history'],
    ['admin.view', '/admin'],
  ];
  const first = order.find(([k]) => user?.permissions[k] !== undefined);
  return first ? <Navigate to={first[1]} replace /> : <EmptyState title="Welcome" hint="Your role has no screens assigned yet. Ask an administrator." />;
}

function Protected() {
  const { user, booting } = useAuth();
  const loc = useLocation();
  if (booting) return <div style={{ padding: 32 }}><LoadingState label="Restoring your session" /></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  return <Shell />;
}

export default function App() {
  return (
    <Suspense fallback={<div style={{ padding: 32 }}><LoadingState /></div>}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Protected />}>
          <Route index element={<Home />} />
          <Route path="pipeline" element={<Gate perm="enquiries.view"><Pipeline /></Gate>} />
          <Route path="enquiries" element={<Gate perm="enquiries.view"><Enquiries /></Gate>} />
          <Route path="enquiries/:id" element={<Gate perm="enquiries.view"><Enquiry360 /></Gate>} />
          <Route path="procurement" element={<Gate perm="procurement_requests.view"><Procurement /></Gate>} />
          <Route path="procurement/:id" element={<Gate perm="procurement_requests.view"><ProcurementDetail /></Gate>} />
          <Route path="estimation" element={<Gate perm="technical_estimations.view"><Estimation /></Gate>} />
          <Route path="estimation/:id" element={<Gate perm="technical_estimations.view"><EstimationDetail /></Gate>} />
          <Route path="quotations" element={<Gate perm="quotations.view"><Quotations /></Gate>} />
          <Route path="quotations/:id" element={<Gate perm="quotations.view"><QuotationBuilder /></Gate>} />
          <Route path="price-history" element={<Gate perm="price_history.view"><PriceHistory /></Gate>} />
          <Route path="approvals" element={<Gate perm="quotations.approve"><Approvals /></Gate>} />
          <Route path="admin" element={<Gate perm="admin.view"><Admin /></Gate>} />
          <Route path="*" element={<EmptyState title="Page not found" hint="Use the navigation on the left." />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
