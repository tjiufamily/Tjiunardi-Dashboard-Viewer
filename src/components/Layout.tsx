import type { PropsWithChildren } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, useLocation } from 'react-router-dom';

export default function Layout({ children }: PropsWithChildren) {
  const { signOut, session } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isHome = location.pathname === '/';

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-left" onClick={() => navigate('/')} role="button" tabIndex={0}>
          <div className="layout-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <div className="layout-title-group">
            <h1 className="layout-title">Dashboard Viewer <span className="layout-title-by">by Tjiunardi Family for the glory of God</span></h1>
            {!isHome && <span className="layout-subtitle">Tjiunardi Research</span>}
          </div>
        </div>
        <div className="layout-header-right">
          <span className="layout-email">{session?.user?.email}</span>
          <button className="btn btn-ghost" onClick={signOut}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            <span className="btn-label">Sign out</span>
          </button>
        </div>
      </header>
      <main className="layout-main">
        {children}
      </main>
    </div>
  );
}
