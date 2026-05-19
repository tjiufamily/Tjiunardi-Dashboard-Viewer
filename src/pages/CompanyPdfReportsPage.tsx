import { useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useCompanies, useGems } from '../hooks/useData';
import { useCompanyPdfList } from '../hooks/useCompanyPdfs';
import { navigateBackWithFallback, readFromState } from '../lib/navigationState';
import { pdfFileUrl, PDF_REPORTS_AVAILABLE } from '../lib/pdfReportsApi';
import {
  comparePdfByNewest,
  comparePdfByOldest,
  formatYearMonth,
  gemSlugToTitle,
  slugify,
  type ParsedPdfFilename,
} from '../lib/pdfReportParse';
import type { Gem } from '../types';

type SortMode = 'newest' | 'oldest' | 'gem-asc';

function gemDisplayName(gemSlug: string, gemsBySlug: Map<string, Gem>): string {
  return gemsBySlug.get(gemSlug)?.name ?? gemSlugToTitle(gemSlug);
}

export default function CompanyPdfReportsPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();

  const company = companies.find((c) => c.id === companyId);
  const { pdfs, loading: pdfsLoading, error: pdfsError, available } = useCompanyPdfList(company?.ticker);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortMode>('newest');
  const [collapsedGems, setCollapsedGems] = useState<Set<string>>(new Set());

  const from = readFromState(location.state);

  const gemsBySlug = useMemo(() => {
    const m = new Map<string, Gem>();
    for (const g of gems) {
      m.set(slugify(g.name), g);
    }
    return m;
  }, [gems]);

  const filteredSorted = useMemo(() => {
    let list = [...pdfs];
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const title = gemDisplayName(p.gemSlug, gemsBySlug).toLowerCase();
        return (
          title.includes(q) ||
          p.gemSlug.includes(q) ||
          p.filename.toLowerCase().includes(q) ||
          p.yearMonth.includes(q)
        );
      });
    }
    if (sort === 'newest') list.sort(comparePdfByNewest);
    else if (sort === 'oldest') list.sort(comparePdfByOldest);
    else {
      list.sort((a, b) => {
        const na = gemDisplayName(a.gemSlug, gemsBySlug);
        const nb = gemDisplayName(b.gemSlug, gemsBySlug);
        const cmp = na.localeCompare(nb);
        return cmp !== 0 ? cmp : comparePdfByNewest(a, b);
      });
    }
    return list;
  }, [pdfs, search, sort, gemsBySlug]);

  const latest = useMemo(() => {
    if (!pdfs.length) return null;
    return [...pdfs].sort(comparePdfByNewest)[0];
  }, [pdfs]);

  const grouped = useMemo(() => {
    const map = new Map<string, ParsedPdfFilename[]>();
    for (const p of filteredSorted) {
      const arr = map.get(p.gemSlug) ?? [];
      arr.push(p);
      map.set(p.gemSlug, arr);
    }
    const groups = [...map.entries()].map(([gemSlug, items]) => ({
      gemSlug,
      title: gemDisplayName(gemSlug, gemsBySlug),
      items,
    }));
    if (sort === 'gem-asc') {
      groups.sort((a, b) => a.title.localeCompare(b.title));
    } else {
      groups.sort((a, b) => {
        const newestA = [...a.items].sort(comparePdfByNewest)[0];
        const newestB = [...b.items].sort(comparePdfByNewest)[0];
        if (!newestA || !newestB) return 0;
        return comparePdfByNewest(newestB, newestA);
      });
    }
    return groups;
  }, [filteredSorted, sort, gemsBySlug]);

  const handleBack = () => {
    navigateBackWithFallback(navigate, from, companyId ? `/company/${companyId}` : '/');
  };

  const toggleGem = (gemSlug: string) => {
    setCollapsedGems((prev) => {
      const next = new Set(prev);
      if (next.has(gemSlug)) next.delete(gemSlug);
      else next.add(gemSlug);
      return next;
    });
  };

  const loading = companiesLoading || gemsLoading || pdfsLoading;

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading PDF reports...</p>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="empty-state">
        <h3>Company not found</h3>
        <button type="button" className="btn btn-primary" onClick={() => navigate('/')}>
          Back to Dashboard
        </button>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="pdf-reports-page">
        <div className="detail-header">
          <button type="button" className="btn btn-ghost btn-back" onClick={handleBack}>
            Back
          </button>
          <h2>PDF Reports</h2>
        </div>
        <div className="empty-state">
          <p>
            PDF reports are only available when running the app locally with <code>npm run dev</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-reports-page">
      <div className="detail-header">
        <button type="button" className="btn btn-ghost btn-back" onClick={handleBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          <span className="btn-label">Back</span>
        </button>
        <div className="detail-title-row">
          <h2>{company.name}</h2>
          <span className="company-ticker large">{company.ticker}</span>
          <span className="detail-run-count">
            {pdfs.length} PDF{pdfs.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="pdf-reports-toolbar">
        <input
          type="search"
          className="search-input"
          placeholder="Search by gem or filename..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="sort-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          aria-label="Sort PDF reports"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="gem-asc">Gem name A–Z</option>
        </select>
      </div>

      {pdfsError ? (
        <div className="pdf-reports-error" role="alert">
          {pdfsError}
          <p className="pdf-reports-hint">
            Ensure <code>REPORTS_DIR</code> in your <code>.env</code> points to your PDF folder and restart{' '}
            <code>npm run dev</code>.
          </p>
        </div>
      ) : null}

      {!pdfsError && pdfs.length === 0 ? (
        <div className="empty-state">
          <h3>No PDF exports yet</h3>
          <p>
            Export PDFs from the desktop app (Batch Export or Save PDF) for <strong>{company.ticker}</strong>.
          </p>
        </div>
      ) : null}

      {!pdfsError && latest && !search.trim() ? (
        <section className="pdf-latest-card" aria-label="Latest PDF report">
          <span className="pdf-latest-label">Latest</span>
          <PdfReportRow pdf={latest} title={gemDisplayName(latest.gemSlug, gemsBySlug)} prominent />
        </section>
      ) : null}

      {!pdfsError && grouped.length > 0 ? (
        <div className="pdf-reports-groups">
          {grouped.map(({ gemSlug, title, items }) => {
            const collapsed = collapsedGems.has(gemSlug);
            const gem = gemsBySlug.get(gemSlug);
            return (
              <section key={gemSlug} className="pdf-gem-group">
                <button
                  type="button"
                  className="pdf-gem-group-header"
                  onClick={() => toggleGem(gemSlug)}
                  aria-expanded={!collapsed}
                >
                  <svg
                    className={`pdf-group-chevron ${collapsed ? '' : 'open'}`}
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                  <span className="pdf-gem-group-title">{title}</span>
                  {gem?.rank != null ? <span className="pdf-gem-rank">#{gem.rank}</span> : null}
                  <span className="pdf-gem-group-count">
                    {items.length} PDF{items.length === 1 ? '' : 's'}
                  </span>
                </button>
                {!collapsed ? (
                  <ul className="pdf-report-list">
                    {items.map((pdf) => (
                      <li key={pdf.filename}>
                        <PdfReportRow
                          pdf={pdf}
                          title={title}
                          showGemSubtitle={items.length > 1}
                        />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      {!pdfsError && pdfs.length > 0 && filteredSorted.length === 0 ? (
        <div className="empty-state">
          <p>No PDFs match your search.</p>
        </div>
      ) : null}
    </div>
  );
}

function PdfReportRow({
  pdf,
  title,
  showGemSubtitle,
  prominent,
}: {
  pdf: ParsedPdfFilename;
  title: string;
  showGemSubtitle?: boolean;
  prominent?: boolean;
}) {
  const url = pdfFileUrl(pdf.filename);
  const dateLabel = formatYearMonth(pdf.yearMonth);

  return (
    <div className={`pdf-report-row ${prominent ? 'pdf-report-row--prominent' : ''}`}>
      <div className="pdf-report-row-main">
        <span className="pdf-report-title">{title}</span>
        {showGemSubtitle ? (
          <span className="pdf-report-filename" title={pdf.filename}>
            {pdf.filename}
          </span>
        ) : null}
        <span className="pdf-report-date">{dateLabel}</span>
        {pdf.isDisambiguated ? (
          <span className="pdf-report-variant" title="Multiple runs in the same month">
            variant
          </span>
        ) : null}
      </div>
      <div className="pdf-report-actions">
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
          View
        </a>
        <a href={url} download={pdf.filename} className="btn btn-primary btn-sm">
          Download
        </a>
      </div>
    </div>
  );
}
