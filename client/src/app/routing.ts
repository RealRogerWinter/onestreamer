/**
 * Pure path-matching helpers extracted verbatim from App.tsx.
 *
 * These are the same `window.location.pathname` checks App previously
 * computed inline at the top of AppContent and again before the main
 * render. Keeping them pure (path passed in) makes them trivially testable
 * and removes branching noise from App without changing any behavior:
 * App still reads `window.location.pathname` once and feeds it here.
 *
 * IMPORTANT: regexes/string checks are copied EXACTLY from the originals to
 * preserve identical matching (case-insensitivity, trailing-slash handling).
 */

export const isOAuthCallbackPath = (pathname: string): boolean =>
  pathname === '/auth/success' || pathname === '/auth/error';

export const isOAuthUsernameSelectionPath = (pathname: string): boolean =>
  pathname === '/auth/complete-registration';

export const isEmailVerificationPath = (pathname: string): boolean =>
  /^\/verify-email\/[a-fA-F0-9]+$/i.test(pathname);

export const isPasswordResetPath = (pathname: string): boolean =>
  /^\/reset-password\/[a-fA-F0-9]+$/i.test(pathname);

export const isDeletionConfirmationPath = (pathname: string): boolean =>
  /^\/confirm-deletion\/[a-fA-F0-9]+$/i.test(pathname);

export const isClipsGalleryPath = (pathname: string): boolean =>
  pathname === '/clips' || pathname === '/clips/';

/**
 * Returns the clip id if the path is a single-clip page, else null.
 * Mirrors `currentPath.match(/^\/clips\/([a-f0-9-]+)$/i)` then `[1]`.
 */
export const matchClipId = (pathname: string): string | null => {
  const clipMatch = pathname.match(/^\/clips\/([a-f0-9-]+)$/i);
  return clipMatch ? clipMatch[1] : null;
};
