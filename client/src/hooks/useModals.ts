import { useState } from 'react';
import type { User } from '../services/AuthService';

/**
 * Consolidates the ~15 modal-visibility flags previously held inline in
 * App.tsx into a single hook. Each flag keeps its original `show*` /
 * `is*Open` name so the call-sites at the JSX boundary stay byte-for-byte
 * identical — we just destructure them from `useModals()` instead of
 * declaring them individually with `useState`.
 *
 * Owns the boolean visibility state for:
 *   - Auth flow: showLogin, showSignup, showEmailVerification,
 *     showPasswordReset, showDeletionConfirmation, showAccountRestoration
 *     (plus the pendingDeletionUser payload that pairs with it)
 *   - User / profile: showProfileSettings, showInventory
 *   - Admin: showAdminPanel + adminPanelTab
 *   - Shop: isShopOpen
 *   - Mobile-only: showMobileChat, showMobileStreamerSettings
 *   - Misc info: showTutorial, showBugReportModal
 *
 * Initial-route awareness (e.g. /verify-email/:token opening the
 * verification modal on mount) is preserved by accepting initial values
 * via the options bag. Anything dynamic that App.tsx used to do in its
 * mount effect — checking `window.location.pathname` — still happens in
 * App.tsx and is forwarded into the hook's initial state, so behaviour
 * is unchanged.
 *
 * Does NOT own:
 *   - Hamburger / theatre overlays already owned elsewhere in App.tsx
 *     (showHamburgerMenu, theatreControlsVisible, theatreDropdownOpen).
 *   - Tutorial default-tab selector (`tutorialDefaultTab`) — it is paired
 *     with showTutorial but is a separate piece of state that other PRs
 *     can fold in if desired.
 *   - showLandscapeChat — that flag is owned by the responsive layout
 *     handling in App.tsx and toggled in concert with the layout, not
 *     by a user clicking a button.
 */
export interface ModalsState {
  // Auth modals
  showLogin: boolean;
  setShowLogin: (value: boolean) => void;
  showSignup: boolean;
  setShowSignup: (value: boolean) => void;
  showEmailVerification: boolean;
  setShowEmailVerification: (value: boolean) => void;
  showPasswordReset: boolean;
  setShowPasswordReset: (value: boolean) => void;
  showDeletionConfirmation: boolean;
  setShowDeletionConfirmation: (value: boolean) => void;
  showAccountRestoration: boolean;
  setShowAccountRestoration: (value: boolean) => void;
  pendingDeletionUser: User | null;
  setPendingDeletionUser: (user: User | null) => void;

  // User / profile
  showProfileSettings: boolean;
  setShowProfileSettings: (value: boolean) => void;
  showInventory: boolean;
  setShowInventory: (value: boolean) => void;

  // Admin
  showAdminPanel: boolean;
  setShowAdminPanel: (value: boolean) => void;
  adminPanelTab: string;
  setAdminPanelTab: (tab: string) => void;

  // Shop
  isShopOpen: boolean;
  setIsShopOpen: (value: boolean) => void;

  // Mobile
  showMobileChat: boolean;
  setShowMobileChat: (value: boolean) => void;
  showMobileStreamerSettings: boolean;
  setShowMobileStreamerSettings: (value: boolean) => void;

  // Info / help
  showTutorial: boolean;
  setShowTutorial: (value: boolean) => void;
  showBugReportModal: boolean;
  setShowBugReportModal: (value: boolean) => void;
}

export interface UseModalsOptions {
  /** Initial value for showEmailVerification — set true when the URL is `/verify-email/:token`. */
  initialShowEmailVerification?: boolean;
  /** Initial value for showPasswordReset — set true when the URL is `/reset-password/:token`. */
  initialShowPasswordReset?: boolean;
  /** Initial value for showDeletionConfirmation — set true when the URL is `/confirm-deletion/:token`. */
  initialShowDeletionConfirmation?: boolean;
}

export function useModals(options: UseModalsOptions = {}): ModalsState {
  const {
    initialShowEmailVerification = false,
    initialShowPasswordReset = false,
    initialShowDeletionConfirmation = false,
  } = options;

  // Auth modals
  const [showLogin, setShowLogin] = useState(false);
  const [showSignup, setShowSignup] = useState(false);
  const [showEmailVerification, setShowEmailVerification] = useState(initialShowEmailVerification);
  const [showPasswordReset, setShowPasswordReset] = useState(initialShowPasswordReset);
  const [showDeletionConfirmation, setShowDeletionConfirmation] = useState(initialShowDeletionConfirmation);
  const [showAccountRestoration, setShowAccountRestoration] = useState(false);
  const [pendingDeletionUser, setPendingDeletionUser] = useState<User | null>(null);

  // User / profile
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const [showInventory, setShowInventory] = useState(false);

  // Admin
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [adminPanelTab, setAdminPanelTab] = useState<string>('dashboard');

  // Shop
  const [isShopOpen, setIsShopOpen] = useState(false);

  // Mobile
  const [showMobileChat, setShowMobileChat] = useState(false);
  const [showMobileStreamerSettings, setShowMobileStreamerSettings] = useState(false);

  // Info / help
  const [showTutorial, setShowTutorial] = useState(false);
  const [showBugReportModal, setShowBugReportModal] = useState(false);

  return {
    showLogin,
    setShowLogin,
    showSignup,
    setShowSignup,
    showEmailVerification,
    setShowEmailVerification,
    showPasswordReset,
    setShowPasswordReset,
    showDeletionConfirmation,
    setShowDeletionConfirmation,
    showAccountRestoration,
    setShowAccountRestoration,
    pendingDeletionUser,
    setPendingDeletionUser,

    showProfileSettings,
    setShowProfileSettings,
    showInventory,
    setShowInventory,

    showAdminPanel,
    setShowAdminPanel,
    adminPanelTab,
    setAdminPanelTab,

    isShopOpen,
    setIsShopOpen,

    showMobileChat,
    setShowMobileChat,
    showMobileStreamerSettings,
    setShowMobileStreamerSettings,

    showTutorial,
    setShowTutorial,
    showBugReportModal,
    setShowBugReportModal,
  };
}
