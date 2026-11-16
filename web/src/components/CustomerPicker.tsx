import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Page } from '../lib/api';
import type { Customer } from '../lib/types';
import { Field } from './ui';

/**
 * Pick a customer by typing.
 *
 * A plain <select> of every customer stops working the moment there are a few
 * hundred of them, and a free-text box would let someone create an enquiry
 * against a customer that does not exist. So: search the server, show what
 * came back, and hold the chosen row until it is cleared.
 */
export function CustomerPicker({
  value, onChange, label = 'Customer', required, hint,
}: {
  value: Customer | null;
  onChange: (c: Customer | null) => void;
  label?: string;
  required?: boolean;
  hint?: string;
}) {
  const [term, setTerm] = useState('');
  const search = term.trim();

  const results = useQuery({
    queryKey: ['customer-search', search],
    enabled: !value && search.length >= 2,
    queryFn: () => api.get<Page<Customer>>('/customers', { q: search, limit: 20, active: 'true' }),
    select: (r) => r.data,
  });

  if (value) {
    return (
      <Field label={label} required={required} hint={hint}>
        {() => (
          <div className="picker__chosen">
            <span>
              <strong>{value.name}</strong>
              <span className="sub">{value.customer_code}{value.location ? ` · ${value.location}` : ''}</span>
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => { onChange(null); setTerm(''); }}>
              Change
            </button>
          </div>
        )}
      </Field>
    );
  }

  return (
    <Field
      label={label}
      required={required}
      hint={hint ?? 'Type at least two letters of the name or code.'}
    >
      {(p) => (
        <div className="picker">
          <input
            {...p}
            className="input"
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search customers…"
            autoComplete="off"
          />
          {search.length >= 2 ? (
            <ul className="picker__list" role="listbox" aria-label="Matching customers">
              {results.isPending ? (
                <li className="picker__msg">Searching…</li>
              ) : results.isError ? (
                <li className="picker__msg">Search failed. Try again.</li>
              ) : (results.data ?? []).length === 0 ? (
                <li className="picker__msg">
                  No customer matches “{search}”. Create it in Customers first, or qualify a lead to create it automatically.
                </li>
              ) : (
                (results.data ?? []).map((c) => (
                  <li key={c.id}>
                    <button type="button" className="picker__item" onClick={() => onChange(c)}>
                      <strong>{c.name}</strong>
                      <span className="sub">{c.customer_code}{c.location ? ` · ${c.location}` : ''}{c.industry ? ` · ${c.industry}` : ''}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
      )}
    </Field>
  );
}
