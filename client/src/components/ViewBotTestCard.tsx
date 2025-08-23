import React from 'react';
import { Play, StopCircle, Copy, Eye, ChevronDown, ChevronUp, MoreVertical, Edit2, Trash2 } from 'lucide-react';

interface ViewBotTestCardProps {
  bot: {
    botId: string;
    name?: string;
    isStreaming: boolean;
    isConnected: boolean;
    lastError?: string;
    config?: {
      contentType?: string;
      videoFile?: string;
      width?: number;
      height?: number;
    };
  };
}

const ViewBotTestCard: React.FC<ViewBotTestCardProps> = ({ bot }) => {
  const [isExpanded, setIsExpanded] = React.useState(false);
  const [showDropdown, setShowDropdown] = React.useState(false);

  const handleStart = () => {
    // console.log('Start button clicked for bot:', bot.botId);
    alert(`Starting bot ${bot.botId}`);
  };

  const handleStop = () => {
    // console.log('Stop button clicked for bot:', bot.botId);
    alert(`Stopping bot ${bot.botId}`);
  };

  const handleClone = () => {
    // console.log('Clone button clicked for bot:', bot.botId);
    alert(`Cloning bot ${bot.botId}`);
  };

  return (
    <div className="viewbot-card test-card" style={{ border: '2px solid #4CAF50', background: 'rgba(76, 175, 80, 0.1)' }}>
      <div className="card-header">
        <div className="card-title">
          <h3>{bot.name || `Test Bot ${bot.botId}`}</h3>
        </div>
        <div className="card-status">
          <span>TEST CARD</span>
        </div>
        <div className="card-actions">
          <div className="dropdown-container">
            <button 
              className="action-menu" 
              onClick={() => setShowDropdown(!showDropdown)}
              type="button"
              style={{ background: '#4CAF50', color: 'white' }}
            >
              <MoreVertical size={18} />
            </button>
            {showDropdown && (
              <div className="dropdown-menu">
                <button 
                  className="dropdown-item"
                  onClick={() => {
                    alert('Dropdown Clone clicked!');
                    setShowDropdown(false);
                  }}
                  type="button"
                >
                  <Copy size={14} /> Test Clone
                </button>
                <button 
                  className="dropdown-item"
                  onClick={() => {
                    alert('Dropdown Rename clicked!');
                    setShowDropdown(false);
                  }}
                  type="button"
                >
                  <Edit2 size={14} /> Test Rename
                </button>
                <div className="dropdown-divider"></div>
                <button 
                  className="dropdown-item danger"
                  onClick={() => {
                    alert('Dropdown Delete clicked!');
                    setShowDropdown(false);
                  }}
                  type="button"
                >
                  <Trash2 size={14} /> Test Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="card-body">
        <div className="quick-info">
          <div className="info-item">
            <span>Test Content Type</span>
          </div>
          <div className="info-item">
            <span>1280x720</span>
          </div>
          <div className="info-item">
            <span>00:00:00</span>
          </div>
        </div>

        <div className="card-controls">
          {!bot.isStreaming ? (
            <button 
              className="control-btn start" 
              onClick={handleStart}
              type="button"
              style={{ background: '#4CAF50', borderColor: '#4CAF50' }}
            >
              <Play size={16} /> Test Start
            </button>
          ) : (
            <button 
              className="control-btn stop" 
              onClick={handleStop}
              type="button"
              style={{ background: '#f44336', borderColor: '#f44336' }}
            >
              <StopCircle size={16} /> Test Stop
            </button>
          )}
          <button 
            className="control-btn" 
            onClick={handleClone}
            type="button"
            style={{ background: '#FF9800', borderColor: '#FF9800' }}
          >
            <Copy size={16} /> Test Clone
          </button>
          <button 
            className="control-btn expand" 
            onClick={() => setIsExpanded(!isExpanded)}
            type="button"
            style={{ background: '#9C27B0', borderColor: '#9C27B0' }}
          >
            {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />} Test Expand
          </button>
        </div>

        {isExpanded && (
          <div className="expanded-content">
            <div style={{ padding: '16px', background: 'rgba(76, 175, 80, 0.1)', borderRadius: '8px', marginTop: '16px' }}>
              <h4>Test Expanded Content</h4>
              <p>This is a test card to validate button functionality.</p>
              <button 
                onClick={() => alert('Expanded content button clicked!')}
                style={{ padding: '8px 16px', background: '#2196F3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
              >
                Test Expanded Button
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ViewBotTestCard;