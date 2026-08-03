import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth';
import type { PendingActivity } from './types';

/**
 * The "do this first" gate.
 *
 * The server is the authority - every student route refuses with 428 and
 * `code: ACTIVITY_REQUIRED` while something is outstanding. This exists so the
 * student is *sent* to the activity instead of being shown an error they
 * cannot act on.
 *
 * Held here rather than in AuthProvider because it changes as the student
 * works through the queue, and finishing one activity may reveal the next.
 */

interface GateState {
  pending: PendingActivity[];
  /** The one to do now: the oldest still outstanding. */
  next: PendingActivity | null;
  /** True until the answer is known for the user who is signed in *now*. */
  loading: boolean;
  refresh: () => Promise<void>;
}

const GateContext = createContext<GateState | null>(null);

export function ActivityGateProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  // The answer is stored together with the user it was fetched for. That is
  // what makes "have we checked yet?" a synchronous question: the moment
  // someone signs in, the previous answer is visibly not theirs, so no render
  // ever gets to treat a stale empty list as "nothing outstanding".
  const [checked, setChecked] = useState<{ userId: string; pending: PendingActivity[] } | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setChecked(null);
      return;
    }
    // Administrators are not held at the door by their own homework.
    if (user.role !== 'STUDENT') {
      setChecked({ userId: user.id, pending: [] });
      return;
    }
    try {
      const res = await api.get<{ pending: PendingActivity[] }>('/api/activities/pending');
      setChecked({ userId: user.id, pending: res.pending });
    } catch {
      // A failure here must not lock a student out of the site: if we cannot
      // tell, we let them through and the server still refuses what it must.
      setChecked({ userId: user.id, pending: [] });
    }
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<GateState>(() => {
    const current = !!user && checked?.userId === user.id;
    const pending = current ? checked!.pending : [];
    return {
      pending,
      next: pending[0] ?? null,
      loading: !!user && !current,
      refresh,
    };
  }, [user, checked, refresh]);

  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

export function useActivityGate(): GateState {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error('useActivityGate must be used inside ActivityGateProvider');
  return ctx;
}
