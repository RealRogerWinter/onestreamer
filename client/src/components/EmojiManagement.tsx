import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './EmojiManagement.css';

interface CustomEmoji {
  id: number;
  name: string;
  code: string;
  url: string;
  file_path: string;
  category: string;
  is_active: boolean;
  usage_count: number;
  created_by: number;
  created_by_username?: string;
  created_at: string;
  updated_at: string;
}

interface EmojiManagementProps {
  addLog: (message: string) => void;
}

const EmojiManagement: React.FC<EmojiManagementProps> = ({ addLog }) => {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [loading, setLoading] = useState(true);
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [editingEmoji, setEditingEmoji] = useState<CustomEmoji | null>(null);
  const [categories, setCategories] = useState<string[]>(['general', 'reactions', 'memes', 'custom']);
  
  // Form state
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    category: 'general',
    file: null as File | null
  });

  useEffect(() => {
    fetchEmojis();
  }, []);

  const fetchEmojis = async () => {
    try {
      const token = authService.getToken();
      const response = await fetch('http://localhost:8080/api/admin/emojis', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const data = await response.json();
        setEmojis(data);
        addLog(`Loaded ${data.length} custom emojis`);
      } else {
        throw new Error('Failed to fetch emojis');
      }
    } catch (error) {
      console.error('Error fetching emojis:', error);
      addLog('Error loading emojis');
    } finally {
      setLoading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Validate file size (500KB max)
      if (file.size > 500000) {
        alert('File size must be less than 500KB');
        return;
      }
      
      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
      if (!allowedTypes.includes(file.type)) {
        alert('Only image files (JPEG, PNG, GIF, WebP, AVIF) are allowed');
        return;
      }
      
      setFormData({ ...formData, file });
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!formData.file || !formData.name || !formData.code) {
      alert('Please fill in all fields and select a file');
      return;
    }
    
    const uploadData = new FormData();
    uploadData.append('emoji', formData.file);
    uploadData.append('name', formData.name);
    uploadData.append('code', formData.code.replace(/^:+|:+$/g, '')); // Remove colons if present
    uploadData.append('category', formData.category);
    
    try {
      const token = authService.getToken();
      const response = await fetch('http://localhost:8080/api/admin/emojis', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: uploadData
      });
      
      if (response.ok) {
        const newEmoji = await response.json();
        addLog(`Uploaded new emoji: ${newEmoji.name}`);
        setShowUploadForm(false);
        setFormData({ name: '', code: '', category: 'general', file: null });
        fetchEmojis();
      } else {
        const error = await response.json();
        throw new Error(error.error || 'Failed to upload emoji');
      }
    } catch (error) {
      console.error('Error uploading emoji:', error);
      alert(error instanceof Error ? error.message : 'Failed to upload emoji');
      addLog('Error uploading emoji');
    }
  };

  const handleUpdate = async (emoji: CustomEmoji) => {
    try {
      const token = authService.getToken();
      const response = await fetch(`http://localhost:8080/api/admin/emojis/${emoji.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: emoji.name,
          code: emoji.code,
          category: emoji.category,
          is_active: emoji.is_active
        })
      });
      
      if (response.ok) {
        addLog(`Updated emoji: ${emoji.name}`);
        setEditingEmoji(null);
        fetchEmojis();
      } else {
        throw new Error('Failed to update emoji');
      }
    } catch (error) {
      console.error('Error updating emoji:', error);
      addLog('Error updating emoji');
    }
  };

  const handleDelete = async (emoji: CustomEmoji) => {
    if (!window.confirm(`Are you sure you want to delete the emoji "${emoji.name}"?`)) {
      return;
    }
    
    try {
      const token = authService.getToken();
      const response = await fetch(`http://localhost:8080/api/admin/emojis/${emoji.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        addLog(`Deleted emoji: ${emoji.name}`);
        fetchEmojis();
      } else {
        throw new Error('Failed to delete emoji');
      }
    } catch (error) {
      console.error('Error deleting emoji:', error);
      addLog('Error deleting emoji');
    }
  };

  const toggleActive = async (emoji: CustomEmoji) => {
    await handleUpdate({ ...emoji, is_active: !emoji.is_active });
  };

  if (loading) {
    return <div className="emoji-management-loading">Loading emojis...</div>;
  }

  return (
    <div className="emoji-management">
      <div className="emoji-management-header">
        <h3>Custom Emoji Management</h3>
        <button 
          className="btn btn-primary"
          onClick={() => setShowUploadForm(!showUploadForm)}
        >
          {showUploadForm ? 'Cancel' : '+ Add Emoji'}
        </button>
      </div>

      {showUploadForm && (
        <div className="emoji-upload-form">
          <h4>Upload New Emoji</h4>
          <form onSubmit={handleUpload}>
            <div className="form-group">
              <label>Name:</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Emoji name"
                required
              />
            </div>
            
            <div className="form-group">
              <label>Code (without colons):</label>
              <input
                type="text"
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                placeholder="kekShook"
                pattern="[a-zA-Z0-9_-]+"
                required
              />
              <small>Users will type :{formData.code || 'code'}: to use this emoji</small>
            </div>
            
            <div className="form-group">
              <label>Category:</label>
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
              >
                {categories.map(cat => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            
            <div className="form-group">
              <label>Image File (max 500KB - JPEG, PNG, GIF, WebP, AVIF):</label>
              <input
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/gif,image/webp,image/avif,.jpg,.jpeg,.png,.gif,.webp,.avif"
                onChange={handleFileChange}
                required
              />
              {formData.file && (
                <small>Selected: {formData.file.name} ({Math.round(formData.file.size / 1024)}KB)</small>
              )}
            </div>
            
            <div className="form-actions">
              <button type="submit" className="btn btn-success">Upload</button>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={() => setShowUploadForm(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="emoji-stats">
        <div className="stat">
          <span className="stat-label">Total Emojis:</span>
          <span className="stat-value">{emojis.length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Active:</span>
          <span className="stat-value">{emojis.filter(e => e.is_active).length}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Total Usage:</span>
          <span className="stat-value">{emojis.reduce((sum, e) => sum + e.usage_count, 0)}</span>
        </div>
      </div>

      <div className="emoji-list">
        <table className="emoji-table">
          <thead>
            <tr>
              <th>Preview</th>
              <th>Name</th>
              <th>Code</th>
              <th>Category</th>
              <th>Usage</th>
              <th>Status</th>
              <th>Created By</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {emojis.map(emoji => (
              <tr key={emoji.id} className={!emoji.is_active ? 'inactive' : ''}>
                <td className="emoji-preview">
                  <img 
                    src={`http://localhost:8080${emoji.url}`} 
                    alt={emoji.name}
                    width="32"
                    height="32"
                  />
                </td>
                <td>
                  {editingEmoji?.id === emoji.id ? (
                    <input
                      type="text"
                      value={editingEmoji.name}
                      onChange={(e) => setEditingEmoji({ ...editingEmoji, name: e.target.value })}
                      className="inline-edit"
                    />
                  ) : (
                    emoji.name
                  )}
                </td>
                <td>
                  {editingEmoji?.id === emoji.id ? (
                    <input
                      type="text"
                      value={editingEmoji.code}
                      onChange={(e) => setEditingEmoji({ ...editingEmoji, code: e.target.value })}
                      className="inline-edit"
                    />
                  ) : (
                    <code>:{emoji.code}:</code>
                  )}
                </td>
                <td>
                  {editingEmoji?.id === emoji.id ? (
                    <select
                      value={editingEmoji.category}
                      onChange={(e) => setEditingEmoji({ ...editingEmoji, category: e.target.value })}
                      className="inline-edit"
                    >
                      {categories.map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  ) : (
                    emoji.category
                  )}
                </td>
                <td>{emoji.usage_count}</td>
                <td>
                  <button
                    className={`status-toggle ${emoji.is_active ? 'active' : 'inactive'}`}
                    onClick={() => toggleActive(emoji)}
                  >
                    {emoji.is_active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td>{emoji.created_by_username || 'System'}</td>
                <td className="emoji-actions">
                  {editingEmoji?.id === emoji.id ? (
                    <>
                      <button 
                        className="btn btn-sm btn-success"
                        onClick={() => handleUpdate(editingEmoji)}
                      >
                        Save
                      </button>
                      <button 
                        className="btn btn-sm btn-secondary"
                        onClick={() => setEditingEmoji(null)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button 
                        className="btn btn-sm btn-primary"
                        onClick={() => setEditingEmoji(emoji)}
                      >
                        Edit
                      </button>
                      <button 
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDelete(emoji)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {emojis.length === 0 && (
          <div className="emoji-empty">
            <p>No custom emojis uploaded yet.</p>
            <p>Click "Add Emoji" to upload your first custom emoji!</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default EmojiManagement;