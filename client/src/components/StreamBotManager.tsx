import React, { useState, useEffect } from 'react';
import authService from '../services/AuthService';
import './StreamBotManager.css';

interface StreamBotMessage {
  id: number;
  message: string;
  enabled: boolean;
  order_index: number;
  created_at: string;
  updated_at: string;
}

interface StreamBotSettings {
  interval_minutes: number;
  enabled: boolean;
  current_message_index: number;
  last_sent_at: string | null;
}

const StreamBotManager: React.FC = () => {
  const [messages, setMessages] = useState<StreamBotMessage[]>([]);
  const [settings, setSettings] = useState<StreamBotSettings | null>(null);
  const [newMessage, setNewMessage] = useState('');
  const [editingMessage, setEditingMessage] = useState<StreamBotMessage | null>(null);
  const [editText, setEditText] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const token = authService.getToken();
      
      // Load settings
      const settingsRes = await fetch('/api/streambot/settings', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (settingsRes.ok) {
        const settingsData = await settingsRes.json();
        setSettings(settingsData);
        setIntervalMinutes(settingsData.interval_minutes);
      }
      
      // Load messages
      const messagesRes = await fetch('/api/streambot/messages', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (messagesRes.ok) {
        const messagesData = await messagesRes.json();
        setMessages(messagesData);
      }
    } catch (err) {
      setError('Failed to load StreamBot data');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const toggleStreamBot = async () => {
    try {
      const token = authService.getToken();
      const res = await fetch('/api/streambot/toggle', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (res.ok) {
        const data = await res.json();
        if (settings) {
          setSettings({ ...settings, enabled: data.enabled });
        }
        setSuccess(`StreamBot ${data.enabled ? 'enabled' : 'disabled'}`);
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to toggle StreamBot');
      console.error(err);
    }
  };

  const updateInterval = async () => {
    try {
      const token = authService.getToken();
      const res = await fetch('/api/streambot/settings', {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ interval_minutes: intervalMinutes })
      });
      
      if (res.ok) {
        const data = await res.json();
        setSettings(data);
        setSuccess('Interval updated successfully');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to update interval');
      console.error(err);
    }
  };

  const addMessage = async () => {
    if (!newMessage.trim()) return;
    
    try {
      const token = authService.getToken();
      const res = await fetch('/api/streambot/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: newMessage })
      });
      
      if (res.ok) {
        const data = await res.json();
        setMessages([...messages, data]);
        setNewMessage('');
        setSuccess('Message added successfully');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to add message');
      console.error(err);
    }
  };

  const updateMessage = async () => {
    if (!editingMessage || !editText.trim()) return;
    
    try {
      const token = authService.getToken();
      const res = await fetch(`/api/streambot/messages/${editingMessage.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: editText })
      });
      
      if (res.ok) {
        const data = await res.json();
        setMessages(messages.map(m => m.id === data.id ? data : m));
        setEditingMessage(null);
        setEditText('');
        setSuccess('Message updated successfully');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to update message');
      console.error(err);
    }
  };

  const deleteMessage = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this message?')) return;
    
    try {
      const token = authService.getToken();
      const res = await fetch(`/api/streambot/messages/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (res.ok) {
        setMessages(messages.filter(m => m.id !== id));
        setSuccess('Message deleted successfully');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to delete message');
      console.error(err);
    }
  };

  const toggleMessage = async (id: number) => {
    try {
      const token = authService.getToken();
      const res = await fetch(`/api/streambot/messages/${id}/toggle`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (res.ok) {
        const data = await res.json();
        setMessages(messages.map(m => m.id === data.id ? data : m));
      }
    } catch (err) {
      setError('Failed to toggle message');
      console.error(err);
    }
  };

  const moveMessage = async (id: number, direction: 'up' | 'down') => {
    const index = messages.findIndex(m => m.id === id);
    if (index === -1) return;
    
    if ((direction === 'up' && index === 0) || 
        (direction === 'down' && index === messages.length - 1)) {
      return;
    }
    
    const newMessages = [...messages];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    [newMessages[index], newMessages[newIndex]] = [newMessages[newIndex], newMessages[index]];
    
    try {
      const token = authService.getToken();
      const messageIds = newMessages.map(m => m.id);
      
      const res = await fetch('/api/streambot/messages/reorder', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messageIds })
      });
      
      if (res.ok) {
        const data = await res.json();
        setMessages(data);
      }
    } catch (err) {
      setError('Failed to reorder messages');
      console.error(err);
    }
  };

  const sendTestMessage = async () => {
    try {
      const token = authService.getToken();
      const res = await fetch('/api/streambot/test', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      
      if (res.ok) {
        setSuccess('Test message sent to chat');
        setTimeout(() => setSuccess(''), 3000);
      }
    } catch (err) {
      setError('Failed to send test message');
      console.error(err);
    }
  };

  if (loading) {
    return <div className="streambot-manager loading">Loading StreamBot settings...</div>;
  }

  return (
    <div className="streambot-manager">
      <h2>StreamBot Manager</h2>
      
      {error && <div className="alert error">{error}</div>}
      {success && <div className="alert success">{success}</div>}
      
      <div className="settings-section">
        <h3>Settings</h3>
        <div className="settings-controls">
          <div className="setting-item">
            <label>Status:</label>
            <button 
              className={`toggle-btn ${settings?.enabled ? 'enabled' : 'disabled'}`}
              onClick={toggleStreamBot}
            >
              {settings?.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
          
          <div className="setting-item">
            <label>Message Interval:</label>
            <div className="interval-control">
              <input
                type="number"
                min="1"
                max="1440"
                value={intervalMinutes}
                onChange={(e) => setIntervalMinutes(parseInt(e.target.value) || 15)}
              />
              <span>minutes</span>
              <button onClick={updateInterval}>Update</button>
            </div>
          </div>
          
          <div className="setting-item">
            <label>Last Sent:</label>
            <span>{settings?.last_sent_at ? new Date(settings.last_sent_at).toLocaleString() : 'Never'}</span>
          </div>
          
          <div className="setting-item">
            <button className="test-btn" onClick={sendTestMessage}>
              Send Test Message
            </button>
          </div>
        </div>
      </div>
      
      <div className="messages-section">
        <h3>Messages ({messages.length})</h3>
        
        <div className="add-message">
          <input
            type="text"
            placeholder="Enter a new promotional message..."
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && addMessage()}
          />
          <button onClick={addMessage}>Add Message</button>
        </div>
        
        <div className="messages-list">
          {messages.map((msg, index) => (
            <div key={msg.id} className={`message-item ${!msg.enabled ? 'disabled' : ''}`}>
              <div className="message-order">#{index + 1}</div>
              
              <div className="message-content">
                {editingMessage?.id === msg.id ? (
                  <div className="edit-mode">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={2}
                    />
                    <div className="edit-actions">
                      <button onClick={updateMessage}>Save</button>
                      <button onClick={() => {
                        setEditingMessage(null);
                        setEditText('');
                      }}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="message-text">{msg.message}</div>
                )}
              </div>
              
              <div className="message-actions">
                <button
                  className="move-btn"
                  onClick={() => moveMessage(msg.id, 'up')}
                  disabled={index === 0}
                  title="Move Up"
                >
                  ↑
                </button>
                <button
                  className="move-btn"
                  onClick={() => moveMessage(msg.id, 'down')}
                  disabled={index === messages.length - 1}
                  title="Move Down"
                >
                  ↓
                </button>
                <button
                  className={`toggle-msg-btn ${msg.enabled ? 'enabled' : 'disabled'}`}
                  onClick={() => toggleMessage(msg.id)}
                  title={msg.enabled ? 'Disable' : 'Enable'}
                >
                  {msg.enabled ? '✓' : '✗'}
                </button>
                <button
                  className="edit-btn"
                  onClick={() => {
                    setEditingMessage(msg);
                    setEditText(msg.message);
                  }}
                  title="Edit"
                >
                  ✏️
                </button>
                <button
                  className="delete-btn"
                  onClick={() => deleteMessage(msg.id)}
                  title="Delete"
                >
                  🗑️
                </button>
              </div>
            </div>
          ))}
          
          {messages.length === 0 && (
            <div className="no-messages">
              No messages configured. Add your first promotional message above!
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StreamBotManager;