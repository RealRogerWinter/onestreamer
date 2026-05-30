import React from 'react';

interface InventoryTabsProps {
  inventorySubTab: string;
  setInventorySubTab: (tab: string) => void;
  isAdmin: boolean;
  onResetCooldowns: () => void;
}

/**
 * Sub-tab / category filter row for the inventory panel (desktop only). Markup
 * preserved verbatim so the characterization tests stay green.
 */
const InventoryTabs: React.FC<InventoryTabsProps> = ({
  inventorySubTab,
  setInventorySubTab,
  isAdmin,
  onResetCooldowns,
}) => {
  return (
    <div className="inventory-tabs">
      <button
        className={`inventory-tab ${inventorySubTab === 'all' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('all')}
      >
        All
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'sound_effects' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('sound_effects')}
      >
        Sound FX
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'visual_effects' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('visual_effects')}
      >
        Visual FX
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'utility' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('utility')}
      >
        Utility
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'powerups' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('powerups')}
      >
        <span>⚡</span>
        <span>Power-ups</span>
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'protection' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('protection')}
      >
        <span>🛡️</span>
        <span>Protection</span>
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'combat' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('combat')}
      >
        <span>⚔️</span>
        <span>Combat</span>
      </button>
      <button
        className={`inventory-tab ${inventorySubTab === 'drawing_tools' ? 'active' : ''}`}
        onClick={() => setInventorySubTab('drawing_tools')}
      >
        <span>🎨</span>
        <span>Drawing</span>
      </button>
      {isAdmin && (
        <button
          className="inventory-admin-button"
          onClick={onResetCooldowns}
          title="Reset all personal item cooldowns (Admin Only)"
        >
          ⏰ Reset Cooldowns
        </button>
      )}
    </div>
  );
};

export default InventoryTabs;
