import React, { useState, useEffect, useCallback } from 'react';

interface ReviewSettingsProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
  onRefresh: () => void;
}

interface Settings {
  retention_days: string;
  upload_enabled: string;
  local_buffer_hours: string;
  b2Enabled: boolean;
  b2BucketName: string | null;
  cleanupStatus?: {
    retentionDays: number;
    pendingDeletion: number;
    totalSessions: number;
    totalStorageMB: number;
  };
  uploadStatus?: {
    enabled: boolean;
    pendingUploads: number;
    queuedSessions: Array<{
      sessionId: string;
      scheduledTime: string;
      ready: boolean;
    }>;
  };
}

const ReviewSettings: React.FC<ReviewSettingsProps> = ({
  makeApiCall,
  addLog,
  onRefresh
}) => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState(7);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeApiCall('/admin/review/settings');

      if (response.success) {
        setSettings(response.settings);
        setRetentionDays(parseInt(response.settings.retention_days || '7'));
        setError(null);
      } else {
        setError(response.error || 'Failed to fetch settings');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to fetch settings');
    } finally {
      setLoading(false);
    }
  }, [makeApiCall]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  const handleSaveRetention = async () => {
    try {
      setSaving(true);
      const response = await makeApiCall('/admin/review/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          retention_days: retentionDays
        })
      });

      if (response.success) {
        addLog(`Retention set to ${retentionDays} days`);
        fetchSettings();
        onRefresh();
      } else {
        setError(response.error || 'Failed to save settings');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-loading">Loading settings...</div>;
  }

  return (
    <div className="review-settings">
      <h3>Recording Review Settings</h3>

      {error && (
        <div className="settings-error">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      <div className="settings-section">
        <h4>Retention Period</h4>
        <p className="section-description">
          Recordings older than this will be automatically deleted from storage.
        </p>

        <div className="retention-control">
          <input
            type="range"
            min="1"
            max="7"
            value={retentionDays}
            onChange={(e) => setRetentionDays(parseInt(e.target.value))}
          />
          <span className="retention-value">{retentionDays} day{retentionDays !== 1 ? 's' : ''}</span>
          <button
            className="save-btn"
            onClick={handleSaveRetention}
            disabled={saving || retentionDays === parseInt(settings?.retention_days || '7')}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <h4>Backblaze B2 Storage</h4>
        <div className="b2-status">
          <div className="status-row">
            <span className="status-label">Status:</span>
            <span className={`status-value ${settings?.b2Enabled ? 'enabled' : 'disabled'}`}>
              {settings?.b2Enabled ? 'Connected' : 'Not Configured'}
            </span>
          </div>
          {settings?.b2BucketName && (
            <div className="status-row">
              <span className="status-label">Bucket:</span>
              <span className="status-value">{settings.b2BucketName}</span>
            </div>
          )}
        </div>
      </div>

      {settings?.cleanupStatus && (
        <div className="settings-section">
          <h4>Storage Status</h4>
          <div className="stats-grid">
            <div className="stat-item">
              <span className="stat-value">{settings.cleanupStatus.totalSessions}</span>
              <span className="stat-label">Total Sessions</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{settings.cleanupStatus.totalStorageMB} MB</span>
              <span className="stat-label">Storage Used</span>
            </div>
            <div className="stat-item">
              <span className="stat-value">{settings.cleanupStatus.pendingDeletion}</span>
              <span className="stat-label">Pending Deletion</span>
            </div>
          </div>
        </div>
      )}

      {settings?.uploadStatus && (
        <div className="settings-section">
          <h4>Upload Queue</h4>
          <div className="upload-status">
            <div className="status-row">
              <span className="status-label">Pending Uploads:</span>
              <span className="status-value">{settings.uploadStatus.pendingUploads}</span>
            </div>
            {settings.uploadStatus.queuedSessions.length > 0 && (
              <div className="upload-queue">
                <table>
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th>Scheduled</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.uploadStatus.queuedSessions.slice(0, 5).map((item) => (
                      <tr key={item.sessionId}>
                        <td>{item.sessionId.slice(0, 20)}...</td>
                        <td>{new Date(item.scheduledTime).toLocaleString()}</td>
                        <td>
                          <span className={`queue-status ${item.ready ? 'ready' : 'waiting'}`}>
                            {item.ready ? 'Ready' : 'Waiting'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="settings-actions">
        <button className="refresh-btn" onClick={fetchSettings}>
          Refresh Settings
        </button>
      </div>
    </div>
  );
};

export default ReviewSettings;
