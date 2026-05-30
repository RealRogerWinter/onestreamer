import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ItemManagement from './ItemManagement';

// ItemManagement loads its data via global fetch() (authenticated with a token
// obtained from authService.getToken()), NOT via dedicated authService data
// methods. So we mock authService.getToken() + the global fetch.
jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

// Deterministic fixtures pinning the current data shape the component renders.
const ITEMS_FIXTURE = [
  {
    id: 1,
    name: 'speed_boost',
    display_name: 'Speed Boost',
    emoji: '⚡',
    description: 'Go faster for a while',
    item_type: 'buff',
    category: 'powerups',
    rarity: 'rare',
    cooldown_seconds: 30,
    duration_seconds: 10,
    max_stack: 5,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    name: 'mud_trap',
    display_name: 'Mud Trap',
    emoji: '🪤',
    description: 'Slow your rivals down',
    item_type: 'debuff',
    category: 'debuffs',
    rarity: 'common',
    cooldown_seconds: 0,
    duration_seconds: 0,
    max_stack: 0,
    created_at: '2025-02-01T00:00:00.000Z',
    updated_at: '2025-02-01T00:00:00.000Z',
  },
];

const SHOP_FIXTURE = [
  {
    shop_item_id: 100,
    item_id: 1,
    price: 1500,
    stock: 0,
    is_featured: true,
    discount_percentage: 10,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    item: ITEMS_FIXTURE[0],
  },
];

// Build a fetch mock that routes by URL + method to deterministic responses.
function installFetchMock() {
  const fetchMock = jest.fn((url: string, opts?: any) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (url === '/api/admin/items' && method === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(ITEMS_FIXTURE) });
    }
    if (url === '/api/admin/shop' && method === 'GET') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(SHOP_FIXTURE) });
    }
    if (url === '/api/admin/items' && method === 'POST') {
      const created = {
        ...JSON.parse(opts.body),
        id: 99,
        created_at: '2025-03-01T00:00:00.000Z',
        updated_at: '2025-03-01T00:00:00.000Z',
      };
      return Promise.resolve({ ok: true, json: () => Promise.resolve(created) });
    }
    // Fallback for any other call (shop add, updates, deletes).
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

const renderComponent = () => {
  const addLog = jest.fn();
  const fetchMock = installFetchMock();
  const utils = render(<ItemManagement addLog={addLog} />);
  return { addLog, fetchMock, ...utils };
};

// The top "🛒 Shop" view-tab and the per-item "🛒 Shop" button share text, so
// target the tab by its .view-tab class.
const clickShopTab = () => {
  const tab = document.querySelector('.view-tab:nth-child(2)') as HTMLElement;
  fireEvent.click(tab);
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ItemManagement (characterization)', () => {
  // 1. Initial view renders header + the three view tabs, items tab active.
  test('renders header and the three view tabs with items active by default', async () => {
    renderComponent();
    expect(screen.getByText('🛍️ Item & Shop Management')).toBeInTheDocument();

    const itemsTab = screen.getByRole('button', { name: /📦 Items/ });
    const shopTab = screen.getByRole('button', { name: /🛒 Shop/ });
    const createTab = screen.getByRole('button', { name: /➕ Create Item/ });
    expect(itemsTab).toBeInTheDocument();
    expect(shopTab).toBeInTheDocument();
    expect(createTab).toBeInTheDocument();
    expect(itemsTab).toHaveClass('active');
    expect(shopTab).not.toHaveClass('active');
  });

  // 2. On mount, it fetches both items and shop endpoints and logs success.
  test('fetches items and shop on mount and logs success', async () => {
    const { fetchMock, addLog } = renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    expect(fetchMock).toHaveBeenCalledWith('/api/admin/items', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/shop', expect.any(Object));
    expect(addLog).toHaveBeenCalledWith('Items fetched successfully');
    expect(addLog).toHaveBeenCalledWith('Shop items fetched successfully');
  });

  // 3. Loaded item rows appear in the items view.
  test('renders loaded item rows in the items view', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());
    expect(screen.getByText('Mud Trap')).toBeInTheDocument();
    // Header count shows filtered-of-total.
    expect(screen.getByText('All Items (2 of 2)')).toBeInTheDocument();
  });

  // 4. Switching to the shop view renders the shop rows.
  test('switching to shop view renders shop items', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    clickShopTab();
    expect(screen.getByText('Shop Items (1)')).toBeInTheDocument();
    expect(screen.getByText('💎 1,500')).toBeInTheDocument();
    expect(screen.getByText('⭐ Featured')).toBeInTheDocument();
  });

  // 5. Switching to the create view renders the create form fields.
  test('switching to create view renders the create form fields', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /➕ Create Item/ }));
    expect(screen.getByText('Create New Item')).toBeInTheDocument();
    expect(screen.getByText('Name (Internal):')).toBeInTheDocument();
    expect(screen.getByText('Display Name:')).toBeInTheDocument();
    expect(screen.getByText('Emoji:')).toBeInTheDocument();
    expect(screen.getByText('Description:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /✨ Create Item/ })).toBeInTheDocument();
  });

  // 6. Search filters the visible item rows.
  test('search term filters the visible items', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/Search items by name or description/);
    fireEvent.change(search, { target: { value: 'mud' } });

    expect(screen.queryByText('Speed Boost')).not.toBeInTheDocument();
    expect(screen.getByText('Mud Trap')).toBeInTheDocument();
    expect(screen.getByText('All Items (1 of 2)')).toBeInTheDocument();
  });

  // 7. Type filter narrows by item_type.
  test('type filter narrows items to the selected type', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const selects = screen.getAllByRole('combobox');
    // Type filter is the first combobox in the items-controls.
    fireEvent.change(selects[0], { target: { value: 'buff' } });

    expect(screen.getByText('Speed Boost')).toBeInTheDocument();
    expect(screen.queryByText('Mud Trap')).not.toBeInTheDocument();
  });

  // 8. Rarity filter narrows by rarity.
  test('rarity filter narrows items to the selected rarity', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const selects = screen.getAllByRole('combobox');
    // Second combobox is the Rarity filter.
    fireEvent.change(selects[1], { target: { value: 'common' } });

    expect(screen.queryByText('Speed Boost')).not.toBeInTheDocument();
    expect(screen.getByText('Mud Trap')).toBeInTheDocument();
  });

  // 9. Sort order toggle flips DOM order of the rendered item cards.
  test('toggling sort order reverses the rendered item order', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const getOrder = () =>
      screen.getAllByRole('heading', { level: 5 }).map((h) => h.textContent);
    // Default sort: name asc -> Mud Trap before Speed Boost.
    expect(getOrder()).toEqual(['Mud Trap', 'Speed Boost']);

    fireEvent.click(screen.getByTitle(/Sort Ascending/));
    expect(getOrder()).toEqual(['Speed Boost', 'Mud Trap']);
  });

  // 10. Clear filters resets search back to showing all items.
  test('clear filters resets the search and shows all items again', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const search = screen.getByPlaceholderText(/Search items by name or description/);
    fireEvent.change(search, { target: { value: 'mud' } });
    expect(screen.getByText('All Items (1 of 2)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /✖ Clear/ }));
    expect(screen.getByText('All Items (2 of 2)')).toBeInTheDocument();
    expect(screen.getByText('Speed Boost')).toBeInTheDocument();
  });

  // 11. Submitting the create form POSTs the new item payload to /api/admin/items.
  test('submitting the create form POSTs the new item to /api/admin/items', async () => {
    const { fetchMock, addLog } = renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /➕ Create Item/ }));

    fireEvent.change(screen.getByPlaceholderText('e.g., speed_boost'), {
      target: { value: 'shield' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g., Speed Boost'), {
      target: { value: 'Shield' },
    });
    fireEvent.change(screen.getByPlaceholderText('⚡'), { target: { value: '🛡️' } });
    fireEvent.change(screen.getByPlaceholderText('Describe what this item does...'), {
      target: { value: 'Blocks damage' },
    });

    fireEvent.click(screen.getByRole('button', { name: /✨ Create Item/ }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/items',
        expect.objectContaining({ method: 'POST' })
      )
    );

    const postCall = fetchMock.mock.calls.find(
      (c: any[]) => c[0] === '/api/admin/items' && c[1]?.method === 'POST'
    );
    const payload = JSON.parse(postCall![1].body);
    expect(payload).toMatchObject({
      name: 'shield',
      display_name: 'Shield',
      emoji: '🛡️',
      description: 'Blocks damage',
      item_type: 'utility',
      rarity: 'common',
    });

    // After a successful create it logs success and returns to the items view.
    await waitFor(() =>
      expect(addLog).toHaveBeenCalledWith('Item "Shield" created successfully')
    );
  });

  // 12. The items refresh button re-fetches the items endpoint.
  test('the items refresh button re-fetches items', async () => {
    const { fetchMock } = renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const itemsGetCallsBefore = fetchMock.mock.calls.filter(
      (c: any[]) => c[0] === '/api/admin/items' && (!c[1] || c[1].method === undefined)
    ).length;

    fireEvent.click(screen.getByRole('button', { name: /🔄 Refresh/ }));

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(
        (c: any[]) => c[0] === '/api/admin/items' && (!c[1] || c[1].method === undefined)
      ).length;
      expect(after).toBeGreaterThan(itemsGetCallsBefore);
    });
  });

  // 13. Entering edit mode on an item card shows Save/Cancel controls.
  test('clicking Edit on an item card reveals the Save and Cancel controls', async () => {
    renderComponent();
    await waitFor(() => expect(screen.getByText('Speed Boost')).toBeInTheDocument());

    const editButtons = screen.getAllByRole('button', { name: /✏️ Edit/ });
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole('button', { name: /💾 Save/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /❌ Cancel/ })).toBeInTheDocument();
  });
});
