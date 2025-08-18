import React, { useState, useEffect, useRef } from 'react';
import './EmojiPicker.css';

interface CustomEmoji {
  id: number;
  name: string;
  code: string;
  url: string;
  category: string;
  usage_count: number;
}

interface EmojiPickerProps {
  onEmojiSelect: (code: string) => void;
  onClose: () => void;
}

const EmojiPicker: React.FC<EmojiPickerProps> = ({ onEmojiSelect, onClose }) => {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const [categories, setCategories] = useState<string[]>(['all']);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [loading, setLoading] = useState(true);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchEmojis();
    
    // Close picker when clicking outside
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const fetchEmojis = async () => {
    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      const response = await fetch(`${apiUrl}/api/emojis`);
      if (response.ok) {
        const data = await response.json();
        setEmojis(data);
        
        // Extract unique categories
        const uniqueCategories = new Set<string>(['all']);
        data.forEach((emoji: CustomEmoji) => {
          if (emoji.category) {
            uniqueCategories.add(emoji.category);
          }
        });
        setCategories(Array.from(uniqueCategories));
      }
    } catch (error) {
      console.error('Error fetching emojis:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEmojiClick = async (emoji: CustomEmoji) => {
    onEmojiSelect(`:${emoji.code}:`);
    
    // Track usage
    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:8080';
      await fetch(`${apiUrl}/api/emojis/${emoji.code}/use`, {
        method: 'POST'
      });
    } catch (error) {
      console.error('Error tracking emoji usage:', error);
    }
  };

  const filteredEmojis = emojis.filter(emoji => {
    const matchesCategory = selectedCategory === 'all' || emoji.category === selectedCategory;
    const matchesSearch = !searchTerm || 
      emoji.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      emoji.code.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  return (
    <div className="emoji-picker" ref={pickerRef}>
      <div className="emoji-picker-header">
        <input
          type="text"
          className="emoji-search"
          placeholder="Search emojis..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          autoFocus
        />
        <button className="emoji-picker-close" onClick={onClose}>×</button>
      </div>
      
      <div className="emoji-categories">
        {categories.map(category => (
          <button
            key={category}
            className={`emoji-category ${selectedCategory === category ? 'active' : ''}`}
            onClick={() => setSelectedCategory(category)}
          >
            {category}
          </button>
        ))}
      </div>
      
      <div className="emoji-grid">
        {loading ? (
          <div className="emoji-loading">Loading emojis...</div>
        ) : filteredEmojis.length === 0 ? (
          <div className="emoji-empty">No emojis found</div>
        ) : (
          filteredEmojis.map(emoji => (
            <button
              key={emoji.id}
              className="emoji-item"
              onClick={() => handleEmojiClick(emoji)}
              title={`:${emoji.code}:`}
            >
              <img 
                src={`${process.env.REACT_APP_API_URL || 'http://localhost:8080'}${emoji.url}`} 
                alt={emoji.name}
                loading="lazy"
              />
              <span className="emoji-tooltip">{`:${emoji.code}:`}</span>
            </button>
          ))
        )}
      </div>
      
      {filteredEmojis.length > 0 && (
        <div className="emoji-picker-footer">
          <span className="emoji-count">{filteredEmojis.length} emojis</span>
          <span className="emoji-hint">Click to insert</span>
        </div>
      )}
    </div>
  );
};

export default EmojiPicker;