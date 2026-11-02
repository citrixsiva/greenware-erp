import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { initials } from '../lib/format';
import type { EnquiryRow, QuotationListRow } from '../lib/types';
import { Icon } from './Icon';

interface NavItem { to: string; label: string; icon: string; perm: string }
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: 'Sales',
    items: [
      { to: '/pipeline', label: 'Pipeline', icon: 'pipeline', perm: 'enquiries.view' },
      { to: '/enquiries', label: 'Enquiries', icon: 'enquiries', perm: 'enquiries.view' },
      { to: '/quotations', label: 'Quotations', icon: 'quotation', perm: 'quotations.view' },
      { to: '/approvals', label: 'Approvals', icon: 'approvals', perm: 'quotations.approve' },
    ],
  },
  {
    label: 'Sourcing',
    items: [
      { to: '/procurement', label: 'Procurement', icon: 'procurement', perm: 'procurement_requests.view' },
      { to: '/estimation', label: 'Estimation', icon: 'estimation', perm: 'technical_estimations.view' },
      { to: '/price-history', label: 'Price history', icon: 'price', perm: 'price_history.view' },
    ],
  },
  { label: 'System', items: [{ to: '/admin', label: 'Admin', icon: 'admin', perm: 'admin.view' }] },
];

/** One link, rendered only when the user holds the permission it needs. */
function RailLink({ item }: { item: NavItem }) {
  const can = useCan(item.perm);
  if (!can) return null;
  return (
    <NavLink to={item.to} className="nav-link">
      <Icon name={item.icon} />
      <span>{item.label}</span>
    </NavLink>
  );
}

function GroupLabel({ group }: { group: (typeof GROUPS)[number] }) {
  const { user } = useAuth();
  const any = group.items.some((i) => user?.permissions[i.perm] !== undefined);
  return any ? <div className="rail__group">{group.label}</div> : null;
}

function GlobalSearch() {
  const navigate = useNavigate();
  const canEnq = useCan('enquiries.view');
  const canQuote = useCan('quotations.view');
  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const enabled = term.length >= 2;
  const enq = useQuery({
    queryKey: ['search', 'enq', term],
    enabled: enabled && canEnq,
    queryFn: async () => (await api.get<Page<EnquiryRow>>('/enquiries', { q: term, limit: 6 })).data,
  });
  const quo = useQuery({
    queryKey: ['search', 'quo', term],
    enabled: enabled && canQuote,
    queryFn: async () => (await api.get<Page<QuotationListRow>>('/quotations', { q: term, limit: 6 })).data,
  });
  const loading = (canEnq && enq.isFetching) || (canQuote && quo.isFetching);
  const none = enabled && !loading && !(enq.data?.length || quo.data?.length);

  function close() {
    setOpen(false);
    setText('');
  }
  function go(to: string) {
    close();
    navigate(to);
  }

  return (
    <div className="search" ref={box} role="search">
      <Icon name="search" />
      <input
        type="search"
        placeholder="Search enquiries, quotations, customers"
        aria-label="Search enquiries and quotations"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && text.trim().length >= 2 && canEnq) go(`/enquiries?q=${encodeURIComponent(text.trim())}`);
        }}
      />
      {open && enabled ? (
        <div className="search__results">
          {loading && !enq.data && !quo.data ? <div className="search__empty">Searching…</div> : null}
          {enq.data?.length ? (
            <>
              <div className="search__group">Enquiries</div>
              {enq.data.map((e) => (
                <Link key={e.id} to={`/enquiries/${e.id}`} className="search__item" onClick={close}>
                  <span className="id muted">{e.enquiry_no}</span>
                  <span className="grow">{e.title} <span className="muted">· {e.customer_name}</span></span>
                </Link>
              ))}
            </>
          ) : null}
          {quo.data?.length ? (
            <>
              <div className="search__group">Quotations</div>
              {quo.data.map((x) => (
                <Link key={x.id} to={`/quotations/${x.id}`} className="search__item" onClick={close}>
                  <span className="id muted">{x.quotation_no}</span>
                  <span className="grow">{x.customer_name} <span className="muted">· {x.enquiry_no}</span></span>
                </Link>
              ))}
            </>
          ) : null}
          {none ? <div className="search__empty">No match for “{term}”.</div> : null}
          {enq.isError ? <div className="search__empty">Search failed. Try again.</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function Shell() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  if (!user) return null;
  const role = user.roles[0]?.replace(/_/g, ' ').toLowerCase() ?? '';

  return (
    <div className="app">
      <aside className="rail" data-open={open} aria-label="Main navigation">
        <div className="rail__brand">
          <div className="rail__logo" aria-hidden="true">G</div>
          <div className="rail__name">Greenware<small>ERP</small></div>
        </div>
        <nav className="rail__nav">
          {GROUPS.map((g) => (
            <div key={g.label} style={{ display: 'contents' }}>
              <GroupLabel group={g} />
              {g.items.map((i) => <RailLink key={i.to} item={i} />)}
            </div>
          ))}
        </nav>
        <div className="rail__foot">Dubai calendar · AED base</div>
      </aside>
      <div className="rail-scrim" data-open={open} onClick={() => setOpen(false)} aria-hidden="true" />

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn--ghost btn--icon menu-btn" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name="menu" size={18} />
          </button>
          <GlobalSearch />
          <div className="right userbox">
            <div className="avatar" aria-hidden="true">{initials(user.displayName)}</div>
            <div className="userbox__name">
              <b>{user.displayName}</b>
              <small>{role}</small>
            </div>
            <button type="button" className="btn btn--sm" onClick={logout}>Sign out</button>
          </div>
        </header>
        <main className="page" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
