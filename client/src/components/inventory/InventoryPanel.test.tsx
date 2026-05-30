import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import InventoryPanel from './InventoryPanel';

// CHARACTERIZATION TESTS — pin CURRENT observable behavior of InventoryPanel.
//
// REAL data mechanism (verified by reading the component):
//  - Inventory/cooldowns/use are loaded via the GLOBAL `fetch()`, authenticated
//    with a token read from `localStorage.getItem('auth_token')` (NOT
//    authService.getToken()).
//  - Admin status comes from `authService.isAdmin()` (the only authService
//    method used). We mock that.
//  - The child grid (InventoryGrid -> InventoryItem) is rendered for real so we
//    can pin the actual DOM (emoji, quantity, cooldown overlay text).

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    isAdmin: jest.fn(() => Promise.resolve(false)),
  },
}));

import authService from '../../services/AuthService';

// The TTS/Soundboard/SummonBot modals only render when an item is selected via
// a use() result; not exercised by these characterization tests, so left real.

const INVENTORY_FIXTURE = [
  {
    inventory_id: 1,
    item_id: 10,
    quantity: 3,
    name: 'air_horn',
    display_name: 'Air Horn',
    emoji: '📯',
    description: 'Blast an air horn',
    item_type: 'utility',
    category: 'sound_effects',
    rarity: 'common',
    cooldown_seconds: 5,
    max_stack: 10,
  },
  {
    inventory_id: 2,
    item_id: 20,
    quantity: 1,
    name: 'confetti',
    display_name: 'Confetti',
    emoji: '🎉',
    description: 'Throw confetti',
    item_type: 'utility',
    category: 'visual_effects',
    rarity: 'rare',
    cooldown_seconds: 0,
    max_stack: 5,
  },
];

const COOLDOWNS_FIXTURE = { itemCooldowns: [] };

function installFetchMock(overrides: Record<string, any> = {}) {
  const fetchMock = jest.fn((url: string, opts?: any) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (url === '/api/inventory' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.inventory ?? INVENTORY_FIXTURE),
      });
    }
    if (url === '/api/inventory/cooldowns' && method === 'GET') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.cooldowns ?? COOLDOWNS_FIXTURE),
      });
    }
    if (url.startsWith('/api/inventory/use/') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            overrides.use ?? {
              remainingQuantity: 2,
              item: { cooldown: 0 },
            }
          ),
      });
    }
    // Fallback: anything else resolves empty-ok.
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

const baseProps = {
  socket: null,
  isAuthenticated: true,
  isOpen: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.setItem('auth_token', 'test-token');
  // Force desktop layout (jsdom default innerWidth is 1024, but pin it).
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 });
  Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 900 });
  (authService.isAdmin as jest.Mock).mockResolvedValue(false);
});

afterEach(() => {
  localStorage.clear();
});

describe('InventoryPanel characterization', () => {
  it('renders the desktop header and the Backpack/Shop main tabs when open', async () => {
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    expect(screen.getByRole('heading', { name: 'Backpack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🎒 Backpack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '🛒 Shop' })).toBeInTheDocument();
  });

  it('renders the sub-tab filter row (All, Sound FX, Visual FX, etc.)', () => {
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sound FX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Visual FX' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Utility' })).toBeInTheDocument();
  });

  it('fetches inventory + cooldowns from the API on open and renders the items', async () => {
    const fetchMock = installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('📯')).toBeInTheDocument();
    });
    expect(screen.getByText('🎉')).toBeInTheDocument();

    // Verify the real endpoints + token were used.
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/inventory/cooldowns',
      expect.anything()
    );
  });

  it('renders item quantity badge for stacked items', async () => {
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('📯')).toBeInTheDocument();
    });
    // air_horn has quantity 3 -> quantity badge shows "3"; confetti qty 1 -> no badge.
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('calls the use endpoint when an in-stock, off-cooldown item is clicked', async () => {
    const fetchMock = installFetchMock();
    const { container } = render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('📯')).toBeInTheDocument();
    });

    // Click the first inventory item tile.
    const tile = container.querySelector('.inventory-item') as HTMLElement;
    expect(tile).toBeTruthy();
    fireEvent.click(tile);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/inventory/use/10',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('switches the active sub-tab class when a filter tab is clicked', () => {
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    const allTab = screen.getByRole('button', { name: 'All' });
    const soundTab = screen.getByRole('button', { name: 'Sound FX' });

    expect(allTab).toHaveClass('active');
    expect(soundTab).not.toHaveClass('active');

    fireEvent.click(soundTab);

    expect(soundTab).toHaveClass('active');
    expect(allTab).not.toHaveClass('active');
  });

  it('filters the rendered items down to the selected category', async () => {
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('📯')).toBeInTheDocument();
    });

    // Switch to Visual FX -> only confetti (🎉) should remain, air horn gone.
    fireEvent.click(screen.getByRole('button', { name: 'Visual FX' }));

    await waitFor(() => {
      expect(screen.queryByText('📯')).not.toBeInTheDocument();
    });
    expect(screen.getByText('🎉')).toBeInTheDocument();
  });

  it('shows the empty-state message for the "all" tab when inventory is empty', async () => {
    installFetchMock({ inventory: [] });
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(
        screen.getByText('Your inventory is empty. Visit the shop to get items!')
      ).toBeInTheDocument();
    });
  });

  it('shows a category-specific empty message when a filtered tab has no items', async () => {
    // Only sound_effects items exist; switching to Utility yields none.
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(screen.getByText('📯')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Utility' }));

    await waitFor(() => {
      expect(screen.getByText('No utility items in inventory')).toBeInTheDocument();
    });
  });

  it('renders the guest prompt (no fetch) when not authenticated', () => {
    const fetchMock = installFetchMock();
    render(<InventoryPanel {...baseProps} isAuthenticated={false} />);

    expect(screen.getByText('Inventory Locked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    // No inventory fetch happens for guests.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/inventory', expect.anything());
  });

  it('fires onLogin / onSignup callbacks from the guest prompt buttons', () => {
    installFetchMock();
    const onLogin = jest.fn();
    const onSignup = jest.fn();
    render(
      <InventoryPanel
        {...baseProps}
        isAuthenticated={false}
        onLogin={onLogin}
        onSignup={onSignup}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(onLogin).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('Create Free Account'));
    expect(onSignup).toHaveBeenCalledTimes(1);
  });

  it('fires onToggleShop when the Shop tab is clicked', () => {
    installFetchMock();
    const onToggleShop = jest.fn();
    render(<InventoryPanel {...baseProps} onToggleShop={onToggleShop} />);

    fireEvent.click(screen.getByRole('button', { name: '🛒 Shop' }));
    expect(onToggleShop).toHaveBeenCalledTimes(1);
  });

  it('fires onToggle when the close button is clicked', () => {
    installFetchMock();
    const onToggle = jest.fn();
    render(<InventoryPanel {...baseProps} onToggle={onToggle} />);

    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the admin "Reset Cooldowns" button only when authService.isAdmin() resolves true', async () => {
    (authService.isAdmin as jest.Mock).mockResolvedValue(true);
    installFetchMock();
    render(<InventoryPanel {...baseProps} />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '⏰ Reset Cooldowns' })
      ).toBeInTheDocument();
    });
  });
});
