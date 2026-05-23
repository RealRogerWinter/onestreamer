import { useCallback, useEffect, useState } from 'react';
import authService, { User } from '../services/AuthService';
import SocketManager from '../services/SocketManager';

/**
 * Encapsulates user-authentication state for the app shell.
 *
 * Owns:
 *   - `isAuthenticated`, `currentUser`, `userPoints`, `isAdmin`, `isModerator`
 *   - Boot-time JWT verification against the server (fresh profile fetch,
 *     pending-deletion detection, socket auth update).
 *   - Admin / moderator role refresh whenever auth flips on.
 *   - User-points fetch whenever auth flips on (and zeroing on logout).
 *
 * Does NOT own:
 *   - Account-restoration modal flow — surfaced via the
 *     `onPendingDeletion` callback so App.tsx can open the modal.
 *   - Socket listeners that update points (e.g. `points-updated`,
 *     `time-stats-update`). Those still live in App.tsx and call into
 *     this hook through the exposed `setUserPoints` and
 *     `setUserPointsFromUpdater` primitives.
 *   - The `ProfileSettings` profile-refresh path, which calls
 *     `refreshCurrentUser` to sync with `authService.getUser()`.
 *
 * Behaviour is preserved verbatim from the original inline state in
 * App.tsx: same localStorage keys, same JWT verification flow, same
 * pending-deletion short-circuit, same admin-flag refresh policy.
 */
export interface AuthState {
  isAuthenticated: boolean;
  currentUser: User | null;
  isAdmin: boolean;
  isModerator: boolean;
  userPoints: number;
  /** Mark a successful login; fetches a fresh profile and updates socket auth. */
  login: () => Promise<void>;
  /** Clear auth state, call AuthService.logout(), and disconnect socket auth. */
  logout: () => Promise<void>;
  /** Set absolute points value (used by socket listener). */
  setUserPoints: (points: number) => void;
  /** Set points via updater (used by socket listener that compares prev->next). */
  setUserPointsFromUpdater: (updater: (prev: number) => number) => void;
  /** Re-read the user from `authService.getUser()` (e.g. after profile edit). */
  refreshCurrentUser: () => void;
  /** Replace currentUser with the supplied user object. */
  setCurrentUser: (user: User | null) => void;
  /** Force-set authentication flag (used by account-restoration completion). */
  setIsAuthenticated: (value: boolean) => void;
  /** Re-fetch user points from the /auth/me endpoint. */
  fetchUserPoints: () => Promise<void>;
}

export interface UseAuthStateOptions {
  /**
   * Fired during boot when the restored user is flagged
   * `pending_deletion`. App.tsx uses this to open the account-restoration
   * modal. The hook has already cleared auth state and called
   * `authService.logout()` before this fires.
   */
  onPendingDeletion?: (user: User) => void;
}

export function useAuthState(options: UseAuthStateOptions = {}): AuthState {
  const { onPendingDeletion } = options;

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() =>
    authService.isAuthenticated()
  );
  const [currentUser, setCurrentUser] = useState<User | null>(() => authService.getUser());
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [isModerator, setIsModerator] = useState<boolean>(false);
  const [userPoints, setUserPointsState] = useState<number>(0);

  // Boot-time auth verification: pull a fresh profile, detect pending
  // deletion, sync socket auth. Mirrors the original inline effect.
  useEffect(() => {
    const initializeAuthentication = async () => {
      const token = authService.getToken();
      if (!token) return;

      try {
        const profile = await authService.getProfile();
        if (profile) {
          if (
            profile.user.accountStatus === 'pending_deletion' ||
            (profile.user as any).account_status === 'pending_deletion'
          ) {
            setIsAuthenticated(false);
            authService.logout();
            onPendingDeletion?.(profile.user);
            return;
          }

          setCurrentUser(profile.user);
          setUserPointsState(profile.stats?.points || 0);
          setIsAuthenticated(true);

          SocketManager.updateAuth(token);

          console.log(
            '✅ App: Restored authenticated session for user:',
            profile.user.username,
            'Points:',
            profile.stats?.points || 0
          );
        } else {
          console.log('❌ App: Failed to restore session, clearing invalid authentication');
          authService.logout();
          setIsAuthenticated(false);
          setCurrentUser(null);
          setUserPointsState(0);
        }
      } catch (error) {
        console.error('❌ App: Error restoring authentication:', error);
        authService.logout();
        setIsAuthenticated(false);
        setCurrentUser(null);
        setUserPointsState(0);
      }
    };

    initializeAuthentication();
    // Boot-once. onPendingDeletion is allowed to change identity safely
    // because we only invoke it during the initial verification window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh admin / moderator status whenever auth flips on.
  useEffect(() => {
    if (!isAuthenticated) return;

    const checkAdmin = async () => {
      const adminStatus = await authService.isAdmin();
      const moderatorStatus = await authService.isModerator();
      setIsAdmin(adminStatus);
      setIsModerator(moderatorStatus);
    };

    checkAdmin();
  }, [isAuthenticated]);

  const fetchUserPoints = useCallback(async () => {
    try {
      const response = await fetch(`${process.env.REACT_APP_SERVER_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${authService.getToken()}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        const points = data.stats?.points || 0;
        setUserPointsState(points);
      }
    } catch (error) {
      console.error('Failed to fetch user points:', error);
    }
  }, []);

  // Fetch points whenever auth flips on; zero them out on logout.
  useEffect(() => {
    if (isAuthenticated) {
      fetchUserPoints();
    } else {
      setUserPointsState(0);
    }
  }, [isAuthenticated, fetchUserPoints]);

  const login = useCallback(async () => {
    setIsAuthenticated(true);

    try {
      const profile = await authService.getProfile();
      if (profile) {
        setCurrentUser(profile.user);
      } else {
        setCurrentUser(authService.getUser());
      }
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      setCurrentUser(authService.getUser());
    }

    await fetchUserPoints();

    const token = authService.getToken();
    SocketManager.updateAuth(token);
  }, [fetchUserPoints]);

  const logout = useCallback(async () => {
    await authService.logout();
    setIsAuthenticated(false);
    setCurrentUser(null);
    setUserPointsState(0);
    SocketManager.updateAuth(null);
  }, []);

  const setUserPoints = useCallback((points: number) => {
    setUserPointsState(points);
  }, []);

  const setUserPointsFromUpdater = useCallback((updater: (prev: number) => number) => {
    setUserPointsState(updater);
  }, []);

  const refreshCurrentUser = useCallback(() => {
    setCurrentUser(authService.getUser());
  }, []);

  return {
    isAuthenticated,
    currentUser,
    isAdmin,
    isModerator,
    userPoints,
    login,
    logout,
    setUserPoints,
    setUserPointsFromUpdater,
    refreshCurrentUser,
    setCurrentUser,
    setIsAuthenticated,
    fetchUserPoints,
  };
}

export default useAuthState;
