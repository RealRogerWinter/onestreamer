import React from 'react';

interface InventoryPaginationProps {
  currentInventoryPage: number;
  setCurrentInventoryPage: React.Dispatch<React.SetStateAction<number>>;
  inventoryItemsPerPage: number;
  inventoryTotalPages: number;
  filteredCount: number;
}

/**
 * Pagination controls for the inventory grid. Markup preserved verbatim so the
 * characterization tests stay green.
 */
const InventoryPagination: React.FC<InventoryPaginationProps> = ({
  currentInventoryPage,
  setCurrentInventoryPage,
  inventoryItemsPerPage,
  inventoryTotalPages,
  filteredCount,
}) => {
  return (
    <div className="inventory-pagination">
      <div className="pagination-info">
        Showing {((currentInventoryPage - 1) * inventoryItemsPerPage) + 1}-{Math.min(currentInventoryPage * inventoryItemsPerPage, filteredCount)} of {filteredCount} items
      </div>

      <div className="pagination-controls">
        <button
          className={`pagination-btn ${currentInventoryPage === 1 ? 'disabled' : ''}`}
          onClick={() => setCurrentInventoryPage(prev => Math.max(1, prev - 1))}
          disabled={currentInventoryPage === 1}
        >
          ← Previous
        </button>

        <div className="pagination-pages">
          {Array.from({ length: inventoryTotalPages }, (_, i) => i + 1).map(page => (
            <button
              key={page}
              className={`pagination-page ${currentInventoryPage === page ? 'active' : ''}`}
              onClick={() => setCurrentInventoryPage(page)}
            >
              {page}
            </button>
          ))}
        </div>

        <button
          className={`pagination-btn ${currentInventoryPage === inventoryTotalPages ? 'disabled' : ''}`}
          onClick={() => setCurrentInventoryPage(prev => Math.min(inventoryTotalPages, prev + 1))}
          disabled={currentInventoryPage === inventoryTotalPages}
        >
          Next →
        </button>
      </div>
    </div>
  );
};

export default InventoryPagination;
