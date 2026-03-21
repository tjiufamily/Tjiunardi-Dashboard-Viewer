import { type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import CompaniesPage from './pages/CompaniesPage';
import CompanyDetailPage from './pages/CompanyDetailPage';
import GemDetailPage from './pages/GemDetailPage';
import ScoresPage from './pages/ScoresPage';
import PositionSizingPage from './pages/PositionSizingPage';
import MetricsComparePage from './pages/MetricsComparePage';
import Layout from './components/Layout';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="loading-screen"><div className="spinner" /></div>;
  if (!session) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p className="loading-text">Loading...</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/" element={
        <ProtectedRoute>
          <Layout><CompaniesPage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/company/:companyId" element={
        <ProtectedRoute>
          <Layout><CompanyDetailPage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/gem/:gemId" element={
        <ProtectedRoute>
          <Layout><GemDetailPage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/scores" element={
        <ProtectedRoute>
          <Layout><ScoresPage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/position-sizing" element={
        <ProtectedRoute>
          <Layout><PositionSizingPage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="/metrics" element={
        <ProtectedRoute>
          <Layout><MetricsComparePage /></Layout>
        </ProtectedRoute>
      } />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
