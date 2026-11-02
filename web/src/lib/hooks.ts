import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type Page, type One, type Query } from './api';
import type { Bootstrap, Employee, Supplier } from './types';
import { useAuth } from './auth';

const DAY = 60 * 60 * 1000;

export function useBootstrap() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['bootstrap'],
    enabled: !!user,
    staleTime: DAY,
    queryFn: async () => (await api.get<One<Bootstrap>>('/masters/bootstrap')).data,
  });
}

export function useEmployees() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['employees'],
    enabled: !!user,
    staleTime: DAY,
    queryFn: async () => (await api.get<Page<Employee>>('/employees', { limit: 200, active: 'true' })).data,
  });
}

export function useSuppliers(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['suppliers'],
    enabled: !!user && enabled,
    staleTime: DAY,
    queryFn: async () => (await api.get<Page<Supplier>>('/suppliers', { limit: 200, active: 'true' })).data,
  });
}

/** Follows nextCursor until the list is complete (bounded, for pickers and small queues). */
export async function fetchAll<T>(path: string, query: Record<string, string | number | boolean | undefined> = {}, maxPages = 5): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page: Page<T> = await api.get<Page<T>>(path, { ...query, limit: 200, cursor });
    out.push(...page.data);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}


/** Cursor-paged list: `rows` is everything loaded so far, `more()` loads the next page. */
export function usePagedList<T>(key: unknown[], path: string, query: Query, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [...key, path, query],
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.get<Page<T>>(path, { limit: 50, ...query, cursor: pageParam }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  return { ...q, rows, hasMore: !!q.hasNextPage, more: () => void q.fetchNextPage() };
}
