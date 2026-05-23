import React, { useState, useEffect } from 'react';
import './BugReportsManagement.css';

interface BugReport {
  id: number;
  username: string;
  reporter_username?: string;
  ip_address: string;
  description: string;
  session_data: any;
  user_agent: string;
  url: string;
  status: 'new' | 'in-progress' | 'resolved' | 'wontfix';
  priority: 'low' | 'medium' | 'high' | 'critical';
  admin_notes: string;
  resolved_at: string | null;
  resolver_username?: string;
  created_at: string;
  updated_at: string;
}

interface BugReportsManagementProps {
  makeApiCall: (endpoint: string, options?: RequestInit) => Promise<any>;
  addLog: (message: string) => void;
}

const BugReportsManagement: React.FC<BugReportsManagementProps> = ({ makeApiCall, addLog }) => {
  const [reports, setReports] = useState<BugReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedReport, setSelectedReport] = useState<BugReport | null>(null);
  const [filter, setFilter] = useState<{ status: string; priority: string }>({
    status: '',
    priority: ''
  });
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 20,
    total: 0,
    pages: 0
  });

  useEffect(() => {
    fetchReports();
  }, [filter, pagination.page]);

  const fetchReports = async () => {
    setLoading(true);
    try {
      const queryParams = new URLSearchParams({
        page: pagination.page.toString(),
        limit: pagination.limit.toString()
      });
      
      if (filter.status) queryParams.append('status', filter.status);
      if (filter.priority) queryParams.append('priority', filter.priority);

      const data = await makeApiCall(`/api/bug-reports?${queryParams}`);
      setReports(data.reports);
      setPagination(prev => ({ ...prev, ...data.pagination }));
      addLog(`Fetched ${data.reports.length} bug reports`);
    } catch (error) {
      addLog(`Failed to fetch bug reports: ${error}`);
    } finally {
      setLoading(false);
    }
  };

  const updateReport = async (id: number, updates: Partial<BugReport>) => {
    try {
      await makeApiCall(`/api/bug-reports/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
      addLog(`Updated bug report #${id}`);
      fetchReports();
      if (selectedReport?.id === id) {
        setSelectedReport(null);
      }
    } catch (error) {
      addLog(`Failed to update bug report: ${error}`);
    }
  };

  const deleteReport = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this bug report?')) return;
    
    try {
      await makeApiCall(`/api/bug-reports/${id}`, {
        method: 'DELETE'
      });
      addLog(`Deleted bug report #${id}`);
      fetchReports();
      if (selectedReport?.id === id) {
        setSelectedReport(null);
      }
    } catch (error) {
      addLog(`Failed to delete bug report: ${error}`);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new': return '#ff6b6b';
      case 'in-progress': return '#ffd93d';
      case 'resolved': return '#6bcf7f';
      case 'wontfix': return '#999';
      default: return '#666';
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical': return '#ff4444';
      case 'high': return '#ff8844';
      case 'medium': return '#ffdd44';
      case 'low': return '#44ff44';
      default: return '#999';
    }
  };

  return (
    <div className="bug-reports-management">
      <div className="bug-reports-header">
        <h3>🐛 Bug Reports Management</h3>
        <div className="bug-reports-stats">
          <span>Total Reports: {pagination.total}</span>
          <span>Page {pagination.page} of {pagination.pages}</span>
        </div>
      </div>

      <div className="bug-reports-filters">
        <select 
          value={filter.status} 
          onChange={(e) => setFilter({ ...filter, status: e.target.value })}
          className="filter-select"
        >
          <option value="">All Status</option>
          <option value="new">New</option>
          <option value="in-progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="wontfix">Won't Fix</option>
        </select>

        <select 
          value={filter.priority} 
          onChange={(e) => setFilter({ ...filter, priority: e.target.value })}
          className="filter-select"
        >
          <option value="">All Priority</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>

        <button onClick={fetchReports} className="refresh-btn">
          🔄 Refresh
        </button>
      </div>

      {loading ? (
        <div className="loading">Loading bug reports...</div>
      ) : (
        <div className="bug-reports-container">
          <div className="bug-reports-list">
            {reports.length === 0 ? (
              <div className="no-reports">No bug reports found</div>
            ) : (
              reports.map(report => (
                <div 
                  key={report.id} 
                  className={`bug-report-item ${selectedReport?.id === report.id ? 'selected' : ''}`}
                  onClick={() => setSelectedReport(report)}
                >
                  <div className="bug-report-header">
                    <span className="bug-id">#{report.id}</span>
                    <span 
                      className="bug-status" 
                      style={{ backgroundColor: getStatusColor(report.status) }}
                    >
                      {report.status}
                    </span>
                    <span 
                      className="bug-priority" 
                      style={{ backgroundColor: getPriorityColor(report.priority) }}
                    >
                      {report.priority}
                    </span>
                  </div>
                  <div className="bug-report-user">
                    {report.reporter_username || report.username || 'Anonymous'}
                  </div>
                  <div className="bug-report-description">
                    {report.description.substring(0, 100)}
                    {report.description.length > 100 && '...'}
                  </div>
                  <div className="bug-report-date">
                    {new Date(report.created_at).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>

          {selectedReport && (
            <div className="bug-report-details">
              <div className="details-header">
                <h4>Bug Report #{selectedReport.id}</h4>
                <button 
                  className="close-details"
                  onClick={() => setSelectedReport(null)}
                >
                  ×
                </button>
              </div>

              <div className="details-content">
                <div className="detail-group">
                  <label>Reporter:</label>
                  <span>{selectedReport.reporter_username || selectedReport.username || 'Anonymous'}</span>
                </div>

                <div className="detail-group">
                  <label>IP Address:</label>
                  <span>{selectedReport.ip_address}</span>
                </div>

                <div className="detail-group">
                  <label>Created:</label>
                  <span>{new Date(selectedReport.created_at).toLocaleString()}</span>
                </div>

                <div className="detail-group">
                  <label>URL:</label>
                  <span>{selectedReport.url || 'N/A'}</span>
                </div>

                <div className="detail-group">
                  <label>Description:</label>
                  <div className="description-text">{selectedReport.description}</div>
                </div>

                <div className="detail-group">
                  <label>Status:</label>
                  <select 
                    value={selectedReport.status}
                    onChange={(e) => updateReport(selectedReport.id, { status: e.target.value as any })}
                    className="status-select"
                  >
                    <option value="new">New</option>
                    <option value="in-progress">In Progress</option>
                    <option value="resolved">Resolved</option>
                    <option value="wontfix">Won't Fix</option>
                  </select>
                </div>

                <div className="detail-group">
                  <label>Priority:</label>
                  <select 
                    value={selectedReport.priority}
                    onChange={(e) => updateReport(selectedReport.id, { priority: e.target.value as any })}
                    className="priority-select"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>

                <div className="detail-group">
                  <label>Admin Notes:</label>
                  <textarea
                    value={selectedReport.admin_notes || ''}
                    onChange={(e) => setSelectedReport({ ...selectedReport, admin_notes: e.target.value })}
                    onBlur={() => updateReport(selectedReport.id, { admin_notes: selectedReport.admin_notes })}
                    placeholder="Add notes about this bug report..."
                    rows={4}
                  />
                </div>

                {selectedReport.resolved_at && (
                  <div className="detail-group">
                    <label>Resolved:</label>
                    <span>
                      {new Date(selectedReport.resolved_at).toLocaleString()}
                      {selectedReport.resolver_username && ` by ${selectedReport.resolver_username}`}
                    </span>
                  </div>
                )}

                <div className="detail-group">
                  <label>Session Data:</label>
                  <details className="session-details">
                    <summary>View Session Info</summary>
                    <pre>{JSON.stringify(selectedReport.session_data, null, 2)}</pre>
                  </details>
                </div>

                <div className="detail-group">
                  <label>User Agent:</label>
                  <div className="user-agent-text">{selectedReport.user_agent}</div>
                </div>

                <div className="detail-actions">
                  <button 
                    className="resolve-btn"
                    onClick={() => updateReport(selectedReport.id, { status: 'resolved' })}
                    disabled={selectedReport.status === 'resolved'}
                  >
                    ✅ Mark Resolved
                  </button>
                  <button 
                    className="delete-btn"
                    onClick={() => deleteReport(selectedReport.id)}
                  >
                    🗑️ Delete Report
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && pagination.pages > 1 && (
        <div className="pagination">
          <button 
            onClick={() => setPagination(prev => ({ ...prev, page: prev.page - 1 }))}
            disabled={pagination.page === 1}
          >
            Previous
          </button>
          <span>Page {pagination.page} of {pagination.pages}</span>
          <button 
            onClick={() => setPagination(prev => ({ ...prev, page: prev.page + 1 }))}
            disabled={pagination.page === pagination.pages}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
};

export default BugReportsManagement;