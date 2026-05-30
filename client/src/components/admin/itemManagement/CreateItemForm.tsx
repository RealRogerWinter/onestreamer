import React from 'react';
import { NewItemForm } from './types';

interface CreateItemFormProps {
  newItem: NewItemForm;
  setNewItem: React.Dispatch<React.SetStateAction<NewItemForm>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}

const CreateItemForm: React.FC<CreateItemFormProps> = ({
  newItem,
  setNewItem,
  onSubmit,
  onCancel,
}) => {
  return (
    <div className="create-view">
      <div className="section-header">
        <h4>Create New Item</h4>
      </div>

      <form onSubmit={onSubmit} className="create-item-form">
        <div className="form-row">
          <div className="form-group">
            <label>Name (Internal):</label>
            <input
              type="text"
              value={newItem.name}
              onChange={(e) => setNewItem({...newItem, name: e.target.value})}
              required
              placeholder="e.g., speed_boost"
            />
          </div>
          <div className="form-group">
            <label>Display Name:</label>
            <input
              type="text"
              value={newItem.display_name}
              onChange={(e) => setNewItem({...newItem, display_name: e.target.value})}
              required
              placeholder="e.g., Speed Boost"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Emoji:</label>
            <input
              type="text"
              value={newItem.emoji}
              onChange={(e) => setNewItem({...newItem, emoji: e.target.value})}
              required
              placeholder="⚡"
              maxLength={2}
            />
          </div>
          <div className="form-group">
            <label>Type:</label>
            <select
              value={newItem.item_type}
              onChange={(e) => setNewItem({...newItem, item_type: e.target.value as any})}
            >
              <option value="buff">Buff</option>
              <option value="debuff">Debuff</option>
              <option value="utility">Utility</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Rarity:</label>
            <select
              value={newItem.rarity}
              onChange={(e) => setNewItem({...newItem, rarity: e.target.value as any})}
            >
              <option value="common">Common</option>
              <option value="uncommon">Uncommon</option>
              <option value="rare">Rare</option>
              <option value="epic">Epic</option>
              <option value="legendary">Legendary</option>
            </select>
          </div>
          <div className="form-group">
            <label>Shop Category:</label>
            <select
              value={newItem.category}
              onChange={(e) => setNewItem({...newItem, category: e.target.value})}
              title="Category for shop organization"
            >
              <option value="utility">Utility</option>
              <option value="powerups">Powerups</option>
              <option value="debuffs">Debuffs</option>
              <option value="visual_effects">Visual Effects</option>
              <option value="sound_effects">Sound Effects</option>
              <option value="drawing_tools">Drawing Tools</option>
              <option value="protection">Protection</option>
              <option value="combat">Combat</option>
              <option value="general">General</option>
              <option value="misc">Misc</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Cooldown (seconds):</label>
            <input
              type="number"
              value={newItem.cooldown_seconds}
              onChange={(e) => setNewItem({...newItem, cooldown_seconds: parseInt(e.target.value)})}
              min="0"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Duration (seconds):</label>
            <input
              type="number"
              value={newItem.duration_seconds}
              onChange={(e) => setNewItem({...newItem, duration_seconds: parseInt(e.target.value)})}
              min="0"
              placeholder="Effect duration"
              title="How long the buff/debuff effect lasts"
            />
          </div>
          <div className="form-group">
            <label>Base Price (Points):</label>
            <input
              type="number"
              value={newItem.base_price}
              onChange={(e) => setNewItem({...newItem, base_price: parseInt(e.target.value)})}
              min="1"
              step="10"
              placeholder="100"
            />
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Max Stack (0 = Unlimited):</label>
            <input
              type="number"
              value={newItem.max_stack}
              onChange={(e) => setNewItem({...newItem, max_stack: parseInt(e.target.value)})}
              min="0"
              placeholder="0 for unlimited"
            />
          </div>
        </div>

        <div className="form-group">
          <label>Description:</label>
          <textarea
            value={newItem.description}
            onChange={(e) => setNewItem({...newItem, description: e.target.value})}
            required
            placeholder="Describe what this item does..."
            rows={3}
          />
        </div>

        <div className="form-actions">
          <button type="submit" className="create-btn">
            ✨ Create Item
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="cancel-btn"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateItemForm;
