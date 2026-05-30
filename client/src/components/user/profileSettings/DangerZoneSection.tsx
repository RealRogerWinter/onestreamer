import React from 'react';

interface DangerZoneSectionProps {
  deletionRequested: boolean;
  setShowDeleteModal: (value: boolean) => void;
}

const DangerZoneSection: React.FC<DangerZoneSectionProps> = ({
  deletionRequested,
  setShowDeleteModal,
}) => {
  return (
    <div className="profile-section danger-zone">
      <h3>Danger Zone</h3>
      <div className="danger-zone-content">
        <div className="danger-zone-item">
          <div className="danger-zone-info">
            <h4>Delete Account</h4>
            <p>Once you delete your account, there is a 15-day grace period before your data is permanently removed. You can restore your account within this period by logging in.</p>
          </div>
          <button
            className="btn btn-danger"
            onClick={() => setShowDeleteModal(true)}
            disabled={deletionRequested}
          >
            {deletionRequested ? 'Deletion Requested' : 'Delete Account'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DangerZoneSection;
