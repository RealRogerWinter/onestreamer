import React, { useState, useEffect, useMemo } from 'react';
import InventoryGrid from './InventoryGrid';
import TTSInputModal from '../soundfx/TTSInputModal';
import SoundboardInputModal from '../soundfx/SoundboardInputModal';
import SummonBotModal from '../soundfx/SummonBotModal';
import { InventoryPanelProps } from './inventoryPanel/types';
import { useInventory } from './inventoryPanel/useInventory';
import { useInventoryPanelGestures } from './inventoryPanel/useInventoryPanelGestures';
import InventoryGuestPrompt from './inventoryPanel/InventoryGuestPrompt';
import InventoryTabs from './inventoryPanel/InventoryTabs';
import InventoryPagination from './inventoryPanel/InventoryPagination';
import './InventoryStyles.css';

const InventoryPanel: React.FC<InventoryPanelProps> = ({
  socket,
  isAuthenticated,
  isOpen = false,
  onToggle,
  onToggleShop,
  onLogin,
  onSignup,
  hideToggleButton = false,
  hideHeader = false
}) => {
  const [inventorySubTab, setInventorySubTab] = useState<string>('all');
  const [currentInventoryPage, setCurrentInventoryPage] = useState(1);
  const inventoryItemsPerPage = 45; // Show many more items in full height panel

  // Check if mobile - using useMemo to ensure it's available for all hooks
  const isMobile = useMemo(() => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  }, []);

  const {
    inventory,
    isLoading,
    error,
    isAdmin,
    ttsModalOpen,
    ttsItem,
    setTtsModalOpen,
    setTtsItem,
    soundboardModalOpen,
    soundboardItem,
    setSoundboardModalOpen,
    setSoundboardItem,
    summonBotModalOpen,
    summonBotItem,
    setSummonBotModalOpen,
    setSummonBotItem,
    handleUseItem,
    handleTTSSubmit,
    handleResetCooldowns,
    handleSoundboardSubmit,
    handleSummonBotSubmit,
    getCooldownForItem,
  } = useInventory({ socket, isAuthenticated, isOpen });

  const {
    panelRef,
    isExpanded,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useInventoryPanelGestures({ isMobile, isOpen, onToggle });

  // Reset to page 1 when inventory tab changes
  useEffect(() => {
    setCurrentInventoryPage(1);
  }, [inventorySubTab]);

  const filteredInventory = isMobile || inventorySubTab === 'all'
    ? inventory
    : inventory.filter(item => item.category === inventorySubTab);

  const getPaginatedInventory = () => {
    const startIndex = (currentInventoryPage - 1) * inventoryItemsPerPage;
    const endIndex = startIndex + inventoryItemsPerPage;
    return filteredInventory.slice(startIndex, endIndex);
  };

  const getInventoryTotalPages = () => {
    return Math.ceil(filteredInventory.length / inventoryItemsPerPage);
  };

  const paginatedInventory = getPaginatedInventory();
  const inventoryTotalPages = getInventoryTotalPages();

  // Always show the inventory panel, but adjust content based on authentication

  return (
    <>
      {/* Hide floating button on mobile since we have bottom nav, and in theatre mode */}
      {!isOpen && !isMobile && !hideToggleButton && (
        <button
          className="inventory-toggle-btn"
          onClick={onToggle}
          title="Open Backpack (B)"
        >
          🎒
        </button>
      )}

      <div
        ref={panelRef}
        className={`inventory-panel ${isOpen ? 'open' : ''} ${isExpanded ? 'expanded' : ''} ${isMobile ? 'mobile' : 'desktop'}`}
        onTouchStart={isMobile ? handleTouchStart : undefined}
        onTouchMove={isMobile ? handleTouchMove : undefined}
        onTouchEnd={isMobile ? handleTouchEnd : undefined}
      >
        {/* Mobile portrait: compact header with swipe handle */}
        {isMobile && (
          <div className="backpack-mobile-header">
            <div className="swipe-handle"></div>
            <div className="backpack-title-row">
              <span className="backpack-title">🎒 Backpack</span>
              <button className="backpack-close-btn" onClick={onToggle}>×</button>
            </div>
          </div>
        )}

        {/* Desktop: full header and tabs */}
        {!isMobile && !hideHeader && (
          <>
            <div className="inventory-header">
              <h2>Backpack</h2>
              <button
                className="inventory-close-btn"
                onClick={onToggle}
              >
                ×
              </button>
            </div>

            <div className="inventory-main-tabs">
              <button
                className="inventory-main-tab active"
              >
                🎒 Backpack
              </button>
              <button
                className="inventory-main-tab shop-toggle"
                onClick={onToggleShop}
                title="Open Shop"
              >
                🛒 Shop
              </button>
            </div>
          </>
        )}

        {!isMobile && (
          <InventoryTabs
            inventorySubTab={inventorySubTab}
            setInventorySubTab={setInventorySubTab}
            isAdmin={isAdmin}
            onResetCooldowns={handleResetCooldowns}
          />
        )}

        <div className="inventory-content">
          {!isAuthenticated ? (
              <InventoryGuestPrompt onLogin={onLogin} onSignup={onSignup} />
            ) : (
              <>
                {error && (
                  <div className="inventory-error">
                    {error}
                  </div>
                )}

                {isLoading ? (
                  <div className="inventory-loading">
                    Loading inventory...
                  </div>
                ) : filteredInventory.length === 0 ? (
                  <div className="inventory-empty">
                    {inventorySubTab === 'all'
                      ? 'Your inventory is empty. Visit the shop to get items!'
                      : `No ${inventorySubTab} items in inventory`
                    }
                  </div>
                ) : (
                  <>
                    <InventoryGrid
                      items={paginatedInventory}
                      onUseItem={handleUseItem}
                      getCooldown={getCooldownForItem}
                    />

                    {inventoryTotalPages > 1 && (
                      <InventoryPagination
                        currentInventoryPage={currentInventoryPage}
                        setCurrentInventoryPage={setCurrentInventoryPage}
                        inventoryItemsPerPage={inventoryItemsPerPage}
                        inventoryTotalPages={inventoryTotalPages}
                        filteredCount={filteredInventory.length}
                      />
                    )}
                  </>
                )}
              </>
            )}
        </div>
      </div>

      {ttsItem && (
        <TTSInputModal
          isOpen={ttsModalOpen}
          onClose={() => {
            setTtsModalOpen(false);
            setTtsItem(null);
          }}
          onSubmit={handleTTSSubmit}
          itemId={ttsItem.item_id}
          itemName={ttsItem.display_name}
          itemEmoji={ttsItem.emoji}
        />
      )}

      {soundboardItem && (
        <SoundboardInputModal
          isOpen={soundboardModalOpen}
          onClose={() => {
            setSoundboardModalOpen(false);
            setSoundboardItem(null);
          }}
          onSubmit={handleSoundboardSubmit}
          itemId={soundboardItem.item_id}
          itemName={soundboardItem.display_name}
          itemEmoji={soundboardItem.emoji}
        />
      )}

      {summonBotItem && (
        <SummonBotModal
          isOpen={summonBotModalOpen}
          onClose={() => {
            setSummonBotModalOpen(false);
            setSummonBotItem(null);
          }}
          onSubmit={handleSummonBotSubmit}
          itemName={summonBotItem.display_name}
          itemEmoji={summonBotItem.emoji}
        />
      )}
    </>
  );
};

export default InventoryPanel;
