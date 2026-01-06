import { useEffect, useCallback, useRef } from 'react';

/**
 * Hook to handle browser back button/gesture for closing dialogs
 *
 * When a dialog opens, it pushes a state to history.
 * When the user presses back, it closes the dialog instead of navigating away.
 */
export function useBackHandler(
  isOpen: boolean,
  onClose: () => void,
  dialogId: string
) {
  const hasAddedState = useRef(false);

  // Handle popstate (back button/gesture)
  const handlePopState = useCallback((event: PopStateEvent) => {
    // Check if this popstate is for our dialog
    if (hasAddedState.current && isOpen) {
      // Prevent default navigation and close the dialog
      onClose();
      hasAddedState.current = false;
    }
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen && !hasAddedState.current) {
      // Push a state when dialog opens
      window.history.pushState({ dialog: dialogId }, '', window.location.href);
      hasAddedState.current = true;
    } else if (!isOpen && hasAddedState.current) {
      // If dialog was closed by other means (not back button), remove the history entry
      // We need to go back to remove our pushed state
      hasAddedState.current = false;
      // Only go back if we still have our state in history
      if (window.history.state?.dialog === dialogId) {
        window.history.back();
      }
    }
  }, [isOpen, dialogId]);

  useEffect(() => {
    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [handlePopState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (hasAddedState.current) {
        hasAddedState.current = false;
      }
    };
  }, []);
}

/**
 * Hook to manage multiple dialogs with back button support
 * Returns functions to open/close dialogs with proper history management
 */
export function useMobileBackNavigation() {
  const activeDialogsRef = useRef<string[]>([]);

  const pushDialog = useCallback((dialogId: string) => {
    if (!activeDialogsRef.current.includes(dialogId)) {
      window.history.pushState({ dialog: dialogId }, '', window.location.href);
      activeDialogsRef.current.push(dialogId);
    }
  }, []);

  const popDialog = useCallback((dialogId: string) => {
    const index = activeDialogsRef.current.indexOf(dialogId);
    if (index !== -1) {
      activeDialogsRef.current.splice(index, 1);
      // Only go back if this dialog's state is current
      if (window.history.state?.dialog === dialogId) {
        window.history.back();
      }
    }
  }, []);

  const handleBackNavigation = useCallback((
    closeHandlers: Record<string, () => void>
  ) => {
    return (event: PopStateEvent) => {
      const dialogId = event.state?.dialog;
      if (dialogId && activeDialogsRef.current.includes(dialogId)) {
        const index = activeDialogsRef.current.indexOf(dialogId);
        if (index !== -1) {
          activeDialogsRef.current.splice(index, 1);
        }
        // Call the close handler for this dialog
        closeHandlers[dialogId]?.();
      }
    };
  }, []);

  return { pushDialog, popDialog, handleBackNavigation, activeDialogsRef };
}

export default useBackHandler;
