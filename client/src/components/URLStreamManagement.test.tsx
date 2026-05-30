import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import URLStreamManagement from './URLStreamManagement';

// URLStreamManagement loads/sends ALL its data through the `makeApiCall` prop
// (endpoint, options?) => Promise<any>, NOT a global fetch or service methods.
// It also calls `addLog(message)` for user-facing log lines. So both are mocked
// with jest.fn() and we route makeApiCall by endpoint+method to deterministic
// fixtures pinning the data shapes the component renders today.

const STREAMS_FIXTURE = [
  {
    urlId: 'stream-1',
    sourceUrl: 'https://twitch.tv/somebody',
    platform: 'twitch',
    displayName: 'My Twitch Relay',
    quality: '720p',
    status: 'streaming',
    startedAt: 1000,
    uptime: 65000,
    reconnectAttempts: 2,
    health: { overall: 92, sourceStatus: 'ok', ffmpegStatus: 'ok' },
  },
];

const PRESETS_FIXTURE = [
  {
    id: 7,
    name: 'xQc Stream',
    source_url: 'https://twitch.tv/xqc',
    platform: 'twitch',
    quality: 'best',
    display_name: 'xQc',
    auto_reconnect: true,
    use_count: 4,
    last_used: '2025-01-01T00:00:00.000Z',
  },
];

const TOOLS_FIXTURE = { streamlink: true, ytdlp: false };

const RANDOM_STATUS_FIXTURE = {
  enabled: false,
  currentStream: null,
  stats: {
    totalRotations: 3,
    startedAt: null,
    streamHistory: [
      {
        urlId: 'hist-1',
        displayName: 'Brave Otter',
        platform: 'kick',
        streamerUsername: 'otterguy',
        streamerDisplayName: 'OtterGuy',
        game: 'Just Chatting',
        title: 'hello',
        viewers: 42,
        url: 'https://kick.com/otterguy',
        startedAt: 500,
      },
    ],
    uptime: 0,
  },
  settings: {
    minRotationMinutes: 5,
    maxRotationMinutes: 10,
    language: 'en',
    minViewers: 1,
    maxViewers: 999999,
    blockedCategories: [],
    platforms: ['twitch', 'kick'],
    platformWeight: { twitch: 50, kick: 50 },
  },
  twitchConfigured: true,
  kickConfigured: true,
  availablePlatforms: [
    { id: 'twitch', name: 'Twitch', icon: '🟣' },
    { id: 'kick', name: 'Kick', icon: '🟢' },
  ],
};

// Build a makeApiCall mock that routes by endpoint + method to deterministic
// responses, mirroring the real server contract the component depends on.
function buildMakeApiCall(overrides: Record<string, any> = {}) {
  return jest.fn((endpoint: string, options?: any) => {
    const method = (options?.method || 'GET').toUpperCase();
    const key = `${method} ${endpoint}`;

    if (key in overrides) {
      return Promise.resolve(overrides[key]);
    }

    if (key === 'GET /api/url-stream') {
      return Promise.resolve({ active: STREAMS_FIXTURE });
    }
    if (key === 'GET /api/url-stream/presets') {
      return Promise.resolve(PRESETS_FIXTURE);
    }
    if (key === 'GET /api/url-stream/tools/status') {
      return Promise.resolve(TOOLS_FIXTURE);
    }
    if (key === 'GET /api/random-stream/status') {
      return Promise.resolve(RANDOM_STATUS_FIXTURE);
    }
    if (key === 'POST /api/url-stream/validate') {
      return Promise.resolve({
        valid: true,
        isLive: true,
        platform: 'twitch',
        title: 'Validated Title',
        qualities: ['best', '720p', '480p'],
      });
    }
    if (endpoint === '/api/url-stream' && method === 'POST') {
      return Promise.resolve({ success: true, urlId: 'new-stream-id' });
    }
    // Default success for starts/stops/deletes/saves/rotation actions.
    return Promise.resolve({ success: true });
  });
}

const renderComponent = (overrides?: Record<string, any>) => {
  const addLog = jest.fn();
  const makeApiCall = buildMakeApiCall(overrides);
  const utils = render(
    <URLStreamManagement makeApiCall={makeApiCall} addLog={addLog} />
  );
  return { addLog, makeApiCall, ...utils };
};

beforeEach(() => {
  jest.clearAllMocks();
  // Mock window.confirm so confirm-gated actions proceed deterministically.
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('URLStreamManagement (characterization)', () => {
  // 1. Renders the header once data has loaded.
  test('renders the header after loading', async () => {
    renderComponent();
    expect(await screen.findByText('URL Stream Relay')).toBeInTheDocument();
    expect(
      screen.getByText('Stream from Twitch, YouTube, Kick & more')
    ).toBeInTheDocument();
  });

  // 2. On mount it fetches streams, presets, tools, and random status.
  test('fetches all data sources on mount', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    expect(makeApiCall).toHaveBeenCalledWith('/api/url-stream');
    expect(makeApiCall).toHaveBeenCalledWith('/api/url-stream/presets');
    expect(makeApiCall).toHaveBeenCalledWith('/api/url-stream/tools/status');
    expect(makeApiCall).toHaveBeenCalledWith('/api/random-stream/status');
  });

  // 3. Tools status reflects the loaded streamlink/yt-dlp availability classes.
  test('renders tool availability badges from tools status', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    const streamlink = screen.getByText('streamlink').closest('.tool-badge');
    const ytdlp = screen.getByText('yt-dlp').closest('.tool-badge');
    expect(streamlink).toHaveClass('available');
    expect(ytdlp).toHaveClass('unavailable');
  });

  // 4. The Active Streams tab is active by default and shows the loaded stream.
  test('shows the active streams tab with the loaded stream by default', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    const streamsTab = screen.getByRole('button', { name: /Active Streams \(1\)/ });
    expect(streamsTab).toHaveClass('active');
    expect(screen.getByText('My Twitch Relay')).toBeInTheDocument();
    expect(screen.getByText('92%')).toBeInTheDocument();
    expect(screen.getByText('Reconnect attempts: 2')).toBeInTheDocument();
  });

  // 5. The tabs show the loaded counts for streams and presets.
  test('tabs reflect the loaded stream and preset counts', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    expect(
      screen.getByRole('button', { name: /Active Streams \(1\)/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Presets \(1\)/ })
    ).toBeInTheDocument();
  });

  // 6. Switching to the Presets tab renders the loaded preset card.
  test('switching to the presets tab renders preset rows', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Presets \(1\)/ }));
    expect(screen.getByText('xQc Stream')).toBeInTheDocument();
    expect(screen.getByText('4 uses')).toBeInTheDocument();
    expect(screen.getByText('Quality: best')).toBeInTheDocument();
  });

  // 7. Validating a URL calls the validate endpoint and shows the result.
  test('validating a URL calls the validate endpoint and shows the result', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.change(
      screen.getByPlaceholderText(/twitch.tv\/username or YouTube\/Kick URL/),
      { target: { value: 'https://twitch.tv/somebody' } }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream/validate',
        expect.objectContaining({ method: 'POST' })
      )
    );
    expect(await screen.findByText('Validated Title')).toBeInTheDocument();
    expect(screen.getByText(/Available: best, 720p, 480p/)).toBeInTheDocument();
  });

  // 8. Starting a stream POSTs the form payload to /api/url-stream.
  test('starting a stream POSTs the form to /api/url-stream', async () => {
    const { makeApiCall, addLog } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.change(
      screen.getByPlaceholderText(/twitch.tv\/username or YouTube\/Kick URL/),
      { target: { value: 'https://twitch.tv/somebody' } }
    );
    fireEvent.click(screen.getByRole('button', { name: /Start Streaming/ }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream',
        expect.objectContaining({ method: 'POST' })
      )
    );

    const postCall = makeApiCall.mock.calls.find(
      (c: any[]) => c[0] === '/api/url-stream' && c[1]?.method === 'POST'
    );
    const payload = JSON.parse(postCall![1].body);
    expect(payload).toMatchObject({
      url: 'https://twitch.tv/somebody',
      quality: 'best',
      autoReconnect: true,
    });
    await waitFor(() =>
      expect(addLog).toHaveBeenCalledWith('Started URL stream: new-stream-id')
    );
  });

  // 9. Stopping a stream DELETEs its url-stream endpoint.
  test('stopping a stream calls DELETE on its endpoint', async () => {
    const { makeApiCall, addLog } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /^Stop$/ }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream/stream-1',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
    await waitFor(() =>
      expect(addLog).toHaveBeenCalledWith('Stopped URL stream: stream-1')
    );
  });

  // 10. Stop All button POSTs to stop-all (after confirm).
  test('Stop All posts to the stop-all endpoint', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Stop All/ }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream/stop-all',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  // 11. Starting from a preset POSTs to the preset start endpoint.
  test('starting from a preset posts to the preset start endpoint', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Presets \(1\)/ }));
    const presetCard = screen.getByText('xQc Stream').closest('.preset-card') as HTMLElement;
    fireEvent.click(within(presetCard).getByRole('button', { name: /Start/ }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream/presets/7/start',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  // 12. Deleting a preset DELETEs its endpoint (after confirm).
  test('deleting a preset calls DELETE on its endpoint', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Presets \(1\)/ }));
    const presetCard = screen.getByText('xQc Stream').closest('.preset-card') as HTMLElement;
    // The preset card has two buttons: Start (first) and Delete (second, trash icon).
    fireEvent.click(within(presetCard).getAllByRole('button')[1]);

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/url-stream/presets/7',
        expect.objectContaining({ method: 'DELETE' })
      )
    );
  });

  // 13. Switching to the Random Rotation tab renders its control panel + stats.
  test('switching to the random rotation tab renders its panel and stats', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Random Rotation/ }));
    expect(screen.getByText('Random Stream Rotation')).toBeInTheDocument();
    expect(screen.getByText('Total Rotations')).toBeInTheDocument();
    expect(screen.getByText('Streams in History')).toBeInTheDocument();
    // History row from the fixture.
    expect(screen.getByText('Brave Otter')).toBeInTheDocument();
  });

  // 14. Starting random rotation posts to the random-stream start endpoint.
  test('starting random rotation posts to the start endpoint', async () => {
    const { makeApiCall } = renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Random Rotation/ }));
    fireEvent.click(screen.getByRole('button', { name: /Start Rotation/ }));

    await waitFor(() =>
      expect(makeApiCall).toHaveBeenCalledWith(
        '/api/random-stream/start',
        expect.objectContaining({ method: 'POST' })
      )
    );
  });

  // 15. Toggling the random settings panel reveals the rotation settings form.
  test('toggling random settings reveals the settings form', async () => {
    renderComponent();
    await screen.findByText('URL Stream Relay');

    fireEvent.click(screen.getByRole('button', { name: /Random Rotation/ }));
    fireEvent.click(screen.getByRole('button', { name: /Settings/ }));

    expect(screen.getByText('Rotation Settings')).toBeInTheDocument();
    expect(screen.getByText('Min Rotation (minutes)')).toBeInTheDocument();
    expect(screen.getByText('Max Viewers')).toBeInTheDocument();
  });

  // 16. Empty streams state renders the placeholder when no streams loaded.
  test('renders the empty state when there are no active streams', async () => {
    renderComponent({ 'GET /api/url-stream': { active: [] } });
    await screen.findByText('URL Stream Relay');

    expect(screen.getByText('No active URL streams')).toBeInTheDocument();
    expect(
      screen.getByText('Enter a stream URL above to start relaying')
    ).toBeInTheDocument();
  });
});
