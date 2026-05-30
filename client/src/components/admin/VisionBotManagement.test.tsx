import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import VisionBotManagement from './VisionBotManagement';
import authService from '../../services/AuthService';

// VisionBotManagement loads ALL of its data via the global `fetch()` API,
// authenticating with `Authorization: Bearer <authService.getToken()>` plus an
// `x-admin-key` header read from `localStorage.adminKey`. There is no
// makeApiCall prop and no socket — the only prop is `addLog`. These
// characterization tests pin the CURRENT observable behavior by mocking
// authService + a URL-routing fetch mock, then asserting the rendered DOM and
// which endpoints each interaction hits.

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

// --- Fixtures -------------------------------------------------------------

const CONFIG = {
  enabled: true,
  streamerId: 'stream-abc',
  vision_prompt_template: 'Describe the scene given [TRANSCRIPTION_DATA].',
  transcription_frequency_s: 120,
  transcription_duration_s: 30,
  image_resolution_px: 512,
  image_quality: 80,
  vision_model: 'meta-llama/llama-4-scout-17b-16e-instruct',
  max_response_tokens: 120,
  temperature: 0.7,
  max_bots_per_cycle: 2,
  frame_retention_hours: 6,
  allow_url_relay: false,
};

const STATUS = {
  enabled: true,
  isActive: true,
  currentStreamerId: 'stream-abc',
  in_flight: false,
  cycles_attempted: 10,
  cycles_succeeded: 8,
  cycles_dropped: { no_egress: 1, groq_429: 1 },
  last_groq_latency_ms: 432,
  consecutive_failures: 0,
  last_success_at: '2026-05-29T12:00:00.000Z',
  last_error_reason: null,
  last_groq_429_at: null,
  kill_switch_env: false,
  config: CONFIG,
};

const BOTS = [
  { id: 1, name: 'AlphaBot', is_enabled: true, vision_bot_enabled: true, is_connected: true },
  { id: 2, name: 'BetaBot', is_enabled: 1, vision_bot_enabled: 0, is_connected: false },
  { id: 3, name: 'DisabledBot', is_enabled: false, vision_bot_enabled: false },
];

const LOGS = {
  logs: [
    { timestamp: '2026-05-29T12:00:00.000Z', eventType: 'cycle', data: { foo: 'bar' } },
  ],
};

// --- fetch mock -----------------------------------------------------------

function okJson(data: any) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response);
}

let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];

function installFetch(opts: { status?: any; bots?: any[]; statusFails?: boolean } = {}) {
  const status = opts.status ?? STATUS;
  const bots = opts.bots ?? BOTS;
  const impl = jest.fn((url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    const method = (options?.method || 'GET').toUpperCase();

    if (url.endsWith('/admin/visionbot/status')) {
      if (opts.statusFails) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('service unavailable'),
        } as unknown as Response);
      }
      return okJson(status);
    }
    if (url.includes('/admin/visionbot/logs')) return okJson(LOGS);
    if (url.endsWith('/admin/visionbot/enable')) return okJson({ ok: true });
    if (url.endsWith('/admin/visionbot/disable')) return okJson({ ok: true });
    if (url.endsWith('/admin/visionbot/config')) return okJson({ ok: true });
    if (/\/api\/chatbots\/\d+$/.test(url)) {
      if (method === 'PUT') return okJson({ ok: true });
    }
    if (url.endsWith('/api/chatbots')) return okJson(bots);

    return okJson({});
  });
  (global as any).fetch = impl;
  return impl;
}

function urlsHit() {
  return fetchCalls.map((c) => c.url);
}

const addLog = jest.fn();

beforeEach(() => {
  // CRA's jest preset uses resetMocks:true, which clears the module-factory
  // jest.fn implementation between tests — re-prime getToken each time.
  (authService.getToken as jest.Mock).mockReturnValue('test-token');
  fetchCalls = [];
  addLog.mockClear();
  localStorage.clear();
  localStorage.setItem('adminKey', 'admin-secret');
  installFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderLoaded() {
  const result = render(<VisionBotManagement addLog={addLog} />);
  // Wait for the status fetch wave to populate the current-stream value.
  await screen.findByText('stream-abc');
  return result;
}

// --- Tests ----------------------------------------------------------------

describe('VisionBotManagement (characterization)', () => {
  it('renders the header and major section headings on initial mount', async () => {
    await renderLoaded();
    expect(
      screen.getByRole('heading', { name: /VisionBot/ })
    ).toBeInTheDocument();
    expect(screen.getByText('Cycle stats')).toBeInTheDocument();
    expect(screen.getByText('Vision prompt template')).toBeInTheDocument();
    expect(screen.getByText('Configuration')).toBeInTheDocument();
    expect(screen.getByText('Per-bot opt-in')).toBeInTheDocument();
  });

  it('fires the initial data-loading fetch wave to status + chatbots endpoints', async () => {
    await renderLoaded();
    const hit = urlsHit();
    expect(hit.some((u) => u.endsWith('/admin/visionbot/status'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/api/chatbots'))).toBe(true);
  });

  it('sends the auth token and admin key in the status fetch headers', async () => {
    await renderLoaded();
    const call = fetchCalls.find((c) => c.url.endsWith('/admin/visionbot/status'));
    const headers = call?.options?.headers as any;
    expect(headers?.Authorization).toBe('Bearer test-token');
    expect(headers?.['x-admin-key']).toBe('admin-secret');
  });

  it('renders the service Enabled and runtime Active badges from status', async () => {
    await renderLoaded();
    expect(screen.getByText('● Enabled')).toBeInTheDocument();
    expect(screen.getByText('● Active')).toBeInTheDocument();
  });

  it('renders the vision-enabled bot ratio over eligible (enabled) bots', async () => {
    await renderLoaded();
    // AlphaBot + BetaBot are enabled (eligible); only AlphaBot is vision-enabled.
    expect(screen.getByText('1 / 2 eligible')).toBeInTheDocument();
  });

  it('renders cycle stats including attempted, succeeded and success percentage', async () => {
    await renderLoaded();
    expect(screen.getByText('Attempted')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('80% success')).toBeInTheDocument();
    expect(screen.getByText('432 ms')).toBeInTheDocument();
  });

  it('renders drop reason counts using the configured labels', async () => {
    await renderLoaded();
    expect(screen.getByText('No egress recording')).toBeInTheDocument();
    expect(screen.getByText('Groq rate-limited')).toBeInTheDocument();
  });

  it('renders the prompt template in read-only display mode initially', async () => {
    await renderLoaded();
    expect(
      screen.getByText('Describe the scene given [TRANSCRIPTION_DATA].')
    ).toBeInTheDocument();
    expect(screen.getByText('✏️ Edit prompt')).toBeInTheDocument();
  });

  it('shows the Disable button when the service is enabled and posts to /disable', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('■ Disable VisionBot'));
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/visionbot/disable') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
    });
  });

  it('shows the Enable button when disabled and posts to /enable', async () => {
    installFetch({ status: { ...STATUS, enabled: false } });
    render(<VisionBotManagement addLog={addLog} />);
    const btn = await screen.findByText('▶ Enable VisionBot');
    fireEvent.click(btn);
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/visionbot/enable') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
    });
  });

  it('enters prompt edit mode and saves via POST /admin/visionbot/config', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('✏️ Edit prompt'));
    const textarea = screen.getByDisplayValue(
      'Describe the scene given [TRANSCRIPTION_DATA].'
    );
    fireEvent.change(textarea, { target: { value: 'New prompt text' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/visionbot/config') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('New prompt text');
      expect(post!.options!.body as string).toContain('vision_prompt_template');
    });
  });

  it('commits a numeric config field on blur via POST /admin/visionbot/config', async () => {
    await renderLoaded();
    const freq = screen
      .getByText('Frequency (s)')
      .closest('label')!
      .querySelector('input') as HTMLInputElement;
    fireEvent.change(freq, { target: { value: '180' } });
    fireEvent.blur(freq);
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/visionbot/config') &&
          (c.options?.method || '').toUpperCase() === 'POST' &&
          (c.options?.body as string)?.includes('transcription_frequency_s')
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('180');
    });
  });

  it('toggles the allow_url_relay checkbox and pushes config immediately', async () => {
    await renderLoaded();
    const checkbox = screen
      .getByText('Allow vision cycles during URL-relay streams')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/visionbot/config') &&
          (c.options?.body as string)?.includes('allow_url_relay')
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('true');
    });
  });

  it('lists only enabled bots in the per-bot opt-in section', async () => {
    await renderLoaded();
    expect(screen.getByText(/AlphaBot/)).toBeInTheDocument();
    expect(screen.getByText(/BetaBot/)).toBeInTheDocument();
    expect(screen.queryByText(/DisabledBot/)).not.toBeInTheDocument();
  });

  it('toggles per-bot vision via PUT /api/chatbots/:id', async () => {
    await renderLoaded();
    const betaRow = screen
      .getByText(/BetaBot/)
      .closest('.vb-bot-row') as HTMLElement;
    const toggle = within(betaRow).getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() => {
      const put = fetchCalls.find(
        (c) =>
          /\/api\/chatbots\/2$/.test(c.url) &&
          (c.options?.method || '').toUpperCase() === 'PUT'
      );
      expect(put).toBeDefined();
      expect(put!.options!.body as string).toContain('vision_bot_enabled');
    });
  });

  it('opens the live logs modal and fetches logs', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('📋 Live Logs'));
    expect(screen.getByText('VisionBot live logs')).toBeInTheDocument();
    await waitFor(() => {
      expect(urlsHit().some((u) => u.includes('/admin/visionbot/logs'))).toBe(true);
    });
  });

  it('refetches status when the Refresh button is clicked', async () => {
    await renderLoaded();
    const before = urlsHit().filter((u) => u.endsWith('/admin/visionbot/status')).length;
    fireEvent.click(screen.getByText('🔄 Refresh'));
    await waitFor(() => {
      const after = urlsHit().filter((u) => u.endsWith('/admin/visionbot/status')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('shows the error banner when the status fetch fails', async () => {
    installFetch({ statusFails: true });
    render(<VisionBotManagement addLog={addLog} />);
    await waitFor(() => {
      expect(
        screen.getByText(/Could not reach the VisionBot service/)
      ).toBeInTheDocument();
    });
  });

  it('shows the kill-switch banner when kill_switch_env is set', async () => {
    installFetch({ status: { ...STATUS, kill_switch_env: true } });
    render(<VisionBotManagement addLog={addLog} />);
    await waitFor(() => {
      expect(screen.getByText('VISIONBOT_KILL_SWITCH=1')).toBeInTheDocument();
    });
  });
});
