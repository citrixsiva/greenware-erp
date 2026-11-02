import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setUnauthorizedHandler, tokenStore } from './api';
import type { User } from './types';

interface AuthState {
  user: User | null;
  /** true while a stored token is being checked against /auth/me */
  booting: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): void;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState<boolean>(() => !!tokenStore.get());

  const logout = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    if (!tokenStore.get()) return;
    let live = true;
    api
      .get<User>('/auth/me')
      .then((u) => live && setUser(u))
      .catch(() => live && tokenStore.set(null))
      .finally(() => live && setBooting(false));
    return () => {
      live = false;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ token: string; user: User }>('/auth/login', { email: email.trim(), password });
      qc.clear();
      tokenStore.set(res.token);
      setUser(res.user);
    },
    [qc],
  );

  const value = useMemo(() => ({ user, booting, login, logout }), [user, booting, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/**
 * Does the signed-in user hold this permission (`<module>.<action>`)? The server is the real gate;
 * this only decides what to show, so a missing permission means the control is not rendered at all.
 */
export function useCan(key: string): boolean {
  const { user } = useAuth();
  return !!user && user.permissions[key] !== undefined;
}

/** For several keys at once, e.g. nav items that need any of a set. */
export function useCanAny(...keys: string[]): boolean {
  const { user } = useAuth();
  return !!user && keys.some((k) => user.permissions[k] !== undefined);
}

/** Field-group visibility from the session (supplier_cost, sell_price, margin, …). */
export function useSeesField(group: string): boolean {
  const { user } = useAuth();
  return !!user && (user.fields.includes(group) || user.fieldsOwnOnly.includes(group));
}
