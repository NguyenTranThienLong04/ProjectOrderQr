import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Login } from './features/auth/Login';
import { AdminLayout } from './features/admin/AdminLayout';
import { TableManager } from './features/admin/TableManager';
import { CategoryManager } from './features/admin/CategoryManager';
import { DishManager } from './features/admin/DishManager';
import { UserManager } from './features/admin/UserManager';
import AdminDashboard from './features/admin/AdminDashboard';
import { CustomerMenu } from './features/menu/CustomerMenu';
import KitchenDisplay from './features/kitchen/KitchenDisplay';
import WaiterDashboard from './features/waiter/WaiterDashboard';
import RequireRole from './components/RequireRole';
import { StaffLayout } from './features/staff/StaffLayout';
import { PaymentResult } from './features/payment/PaymentResult';
import { PromotionManager } from './features/admin/PromotionManager';

function RouteFocus() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0 });
    window.setTimeout(() => document.querySelector<HTMLElement>('#main-content')?.focus(), 0);
  }, [pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <RouteFocus />
      <Routes>
        {/* Auth Route */}
        <Route path="/login" element={<Login />} />
        <Route path="/menu" element={<CustomerMenu />} />
        <Route path="/payment-result" element={<PaymentResult />} />

        {/* Protected Admin Routes */}
        <Route path="/admin" element={<RequireRole roles={["admin"]}><AdminLayout /></RequireRole>}>
          <Route index element={<Navigate to="/admin/analytics" replace />} />
          <Route path="analytics" element={<RequireRole roles={["admin"]}><AdminDashboard /></RequireRole>} />
          <Route path="tables" element={<TableManager />} />
          <Route path="categories" element={<RequireRole roles={["admin"]}><CategoryManager /></RequireRole>} />
          <Route path="dishes" element={<RequireRole roles={["admin"]}><DishManager /></RequireRole>} />
          <Route path="users" element={<RequireRole roles={["admin"]}><UserManager /></RequireRole>} />
          <Route path="promotions" element={<RequireRole roles={["admin"]}><PromotionManager /></RequireRole>} />
        </Route>

        {/* Kitchen & Waiter for staff */}
        <Route element={<StaffLayout />}>
         <Route path="/kitchen" element={<RequireRole roles={["kitchen"]}><KitchenDisplay /></RequireRole>} />
         <Route path="/waiter" element={<RequireRole roles={["waiter"]}><WaiterDashboard /></RequireRole>} />
        </Route>
        {/* Redirect Root to Login */}
        <Route path="/" element={<Navigate to="/login" replace />} />

        {/* Fallback Catch-all Route */}
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
