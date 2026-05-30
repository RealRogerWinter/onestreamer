import React from 'react';
import CookieConsentService from '../../../services/CookieConsentService';

const PrivacySection: React.FC = () => {
  return (
    <div className="profile-section privacy-section">
      <h3>Privacy Settings</h3>
      <div className="privacy-content">
        <div className="privacy-item">
          <div className="privacy-info">
            <h4>Cookie Preferences</h4>
            <p>Manage your cookie settings and control what data is collected about your browsing experience.</p>
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => CookieConsentService.showPreferences()}
          >
            Manage Cookies
          </button>
        </div>
      </div>
    </div>
  );
};

export default PrivacySection;
