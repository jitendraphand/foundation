import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  error: string | null;
  /** Why the last session ended, if it ended rather than simply not existing. */
  endedReason: string | null;
  clearEndedReason: () => void;
  /** True when the signed-in user holds every listed privilege. */
  can: (...required: string[]) => boolean;
  /** True when they hold at least one of them. */
  canAny: (...required: string[]) => boolean;
  login: (username: string, password: string) => Promise<Me>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: Me | null) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<{ user: Me }>('/api/auth/me');
      setUser(res.user);
      setError(null);
    } catch (err) {
      // A 401 here is the normal "not signed in" case, not a failure - unless
      // the server says the session was ended, which is worth explaining.
      setUser(null);
      if (err instanceof ApiError && err.sessionEnded) setEndedReason(err.message);
      if (err instanceof ApiError && err.status === 0) setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Any request may discover the session has ended; the api layer announces it
  // once and this is the single place that acts on it.
  useEffect(() => {
    const onEnded = (event: Event) => {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setUser(null);
      setEndedReason(message ?? 'Your session has ended. Please sign in again.');
    };
    window.addEventListener('foundation:session-ended', onEnded);
    return () => window.removeEventListener('foundation:session-ended', onEnded);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.post<{ user: Me }>('/api/auth/login', { username: username.trim().toLowerCase(), password });
    setEndedReason(null);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(() => {
    const granted = user?.permissions ?? [];
    return {
      user,
      loading,
      error,
      endedReason,
      clearEndedReason: () => setEndedReason(null),
      // The server enforces all of this; hiding what a user cannot use is a
      // courtesy so they are not shown buttons that will only refuse them.
      can: (...required: string[]) => required.every((r) => granted.includes(r)),
      canAny: (...required: string[]) => required.some((r) => granted.includes(r)),
      login,
      logout,
      refresh,
      setUser,
    };
  }, [user, loading, error, endedReason, login, logout, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
