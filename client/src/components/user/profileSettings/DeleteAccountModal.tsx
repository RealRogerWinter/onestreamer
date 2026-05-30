import React from 'react';
import { UserData } from './types';

interface DeleteAccountModalProps {
  userData: UserData | null;
  deleteConfirmText: string;
  setDeleteConfirmText: (value: string) => void;
  loading: boolean;
  error: string | null;
  handleDeleteAccountRequest: () => void;
  handleCancelDeletion: () => void;
}

const DeleteAccountModal: React.FC<DeleteAccountModalProps> = ({
  userData,
  deleteConfirmText,
  setDeleteConfirmText,
  loading,
  error,
  handleDeleteAccountRequest,
  handleCancelDeletion,
}) => {
  return (
    <div className="delete-modal-overlay" onClick={handleCancelDeletion}>
      <div className="delete-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Delete Account</h3>

        {(userData?.isVerified || userData?.is_verified) ? (
          <>
            <div className="delete-modal-warning">
              <p><strong>Warning:</strong> This action will delete your account and all associated data.</p>
              <ul>
                <li>Your account will be flagged for deletion immediately</li>
                <li>You will receive an email to confirm this action</li>
                <li>After confirmation, you have 15 days to restore your account</li>
                <li>After 15 days, all your data will be permanently deleted</li>
              </ul>
            </div>

            <div className="delete-confirmation-input">
              <label>Type <strong>DELETE MY ACCOUNT</strong> to confirm:</label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="Type here to confirm"
                disabled={loading}
              />
            </div>

            {error && (
              <div className="alert alert-error">
                {error}
              </div>
            )}

            <div className="delete-modal-actions">
              <button
                className="btn btn-danger"
                onClick={handleDeleteAccountRequest}
                disabled={loading || deleteConfirmText !== 'DELETE MY ACCOUNT'}
              >
                {loading ? 'Processing...' : 'Request Deletion'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleCancelDeletion}
                disabled={loading}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="delete-modal-unverified">
            <p>Your email address must be verified before you can delete your account.</p>
            <p>Please verify your email first or contact an administrator at support@onestreamer.live for assistance with account deletion.</p>
            <div className="delete-modal-actions">
              <button
                className="btn btn-secondary"
                onClick={handleCancelDeletion}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeleteAccountModal;
