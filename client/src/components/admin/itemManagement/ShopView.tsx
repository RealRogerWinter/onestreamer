import React from 'react';
import { ShopItemData, getRarityColor, getTypeIcon } from './types';

interface ShopViewProps {
  shopItems: ShopItemData[];
  onRefresh: () => void;
  onUpdateShopItem: (shopItemId: number, updates: Partial<ShopItemData>) => void;
  onRemoveFromShop: (shopItemId: number) => void;
}

const ShopView: React.FC<ShopViewProps> = ({
  shopItems,
  onRefresh,
  onUpdateShopItem,
  onRemoveFromShop,
}) => {
  return (
    <div className="shop-view">
      <div className="section-header">
        <h4>Shop Items ({shopItems.length})</h4>
        <button onClick={onRefresh} className="refresh-btn">
          🔄 Refresh
        </button>
      </div>

      <div className="shop-items-grid">
        {shopItems.map((shopItem) => (
          <div key={shopItem.shop_item_id} className="shop-item-card">
            <div className="shop-item-header">
              <span className="item-emoji">{shopItem.item?.emoji}</span>
              <div className="item-info">
                <h5 style={{ color: getRarityColor(shopItem.item?.rarity || 'common') }}>
                  {shopItem.item?.display_name}
                </h5>
                <div className="item-meta">
                  <span className="item-type">
                    {getTypeIcon(shopItem.item?.item_type || 'utility')} {shopItem.item?.item_type}
                  </span>
                  {shopItem.is_featured && (
                    <span className="featured-badge">⭐ Featured</span>
                  )}
                </div>
              </div>
            </div>

            <div className="shop-item-pricing">
              <div className="price">
                <span>Price:</span>
                <span>💎 {shopItem.price.toLocaleString()}</span>
              </div>
              <div className="stock">
                <span>Stock:</span>
                <span>{shopItem.stock === 0 ? 'Unlimited' : shopItem.stock}</span>
              </div>
              {shopItem.discount_percentage && (
                <div className="discount">
                  <span>Discount:</span>
                  <span>{shopItem.discount_percentage}%</span>
                </div>
              )}
            </div>

            <div className="shop-item-actions">
              <button
                onClick={() => {
                  const newPrice = prompt('New price:', shopItem.price.toString());
                  if (newPrice) {
                    onUpdateShopItem(shopItem.shop_item_id, { price: parseInt(newPrice) });
                  }
                }}
                className="update-btn"
              >
                💰 Update Price
              </button>
              <button
                onClick={() => {
                  const newStock = prompt('New stock (0 for unlimited):', shopItem.stock.toString());
                  if (newStock) {
                    onUpdateShopItem(shopItem.shop_item_id, { stock: parseInt(newStock) });
                  }
                }}
                className="update-btn"
              >
                📦 Update Stock
              </button>
              <button
                onClick={() => {
                  onUpdateShopItem(shopItem.shop_item_id, { is_featured: !shopItem.is_featured });
                }}
                className={`feature-btn ${shopItem.is_featured ? 'featured' : ''}`}
              >
                {shopItem.is_featured ? '⭐ Unfeature' : '⭐ Feature'}
              </button>
              <button
                onClick={() => {
                  if (window.confirm('Remove this item from the shop?')) {
                    onRemoveFromShop(shopItem.shop_item_id);
                  }
                }}
                className="remove-btn"
              >
                🗑️ Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ShopView;
