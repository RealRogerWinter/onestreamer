import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import TranscriptionManagement from './TranscriptionManagement';
import authService from '../../services/AuthService';
import { useMainSocket } from '../../contexts/SocketContext';

// TranscriptionManagement loads/mutates ALL of its data via the global `fetch()`
// API, authenticating with `Authorization: Bearer <authService.getToken()>` plus
// an `x-admin-key` header read from localStorage for the /admin/* endpoints. It
// ALSO consumes the main socket via `useMainSocket()` (from SocketContext) to
// receive transcription/buffer/stream events. The only prop is `addLog`.
//
// These characterization tests pin the CURRENT observable behavior by mocking
// authService + useMainSocket + a URL-routing fetch mock, then asserting the
// rendered DOM and which endpoints each interaction hits.

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

jest.mock('../../contexts/SocketContext', () => ({
  __esModule: true,
  useMainSocket: jest.fn(),
}));

// --- Fixtures -------------------------------------------------------------

const STATUS_RESPONSE = {
  status: {
    enabled: true,
    autoStart: true,
    model: 'base',
    language: 'es',
    chunkDuration: 10000,
    bufferDuration: 120,
    activeCount: 1,
    activeSessions: [
      {
        id: 'sess-active-1',
        streamerId: 'streamer-7',
        startTime: '2025-01-01T00:00:00.000Z',
        status: 'active',
        wordCount: 12,
        chunkCount: 3,
      },
    ],
  },
};

const HISTORY_RESPONSE = {
  transcriptions: [
    {
      id: 'abcdef1234567890',
      streamer_id: 'streamer-7',
      start_time: '2025-01-01T00:00:00.000Z',
      end_time: '2025-01-01T00:02:00.000Z',
      duration: 125,
      word_count: 42,
      language: 'en',
      status: 'completed',
      full_text: 'Hello world this is a transcript.',
    },
  ],
};

const ACTIVE_STREAM_RESPONSE = { isActive: true, streamerId: 'streamer-7' };

// Status with an active stream but NO active sessions — leaves currentSessionId
// null so the "Record & Transcribe" button stays enabled.
const STATUS_NO_SESSIONS = {
  status: {
    enabled: true,
    autoStart: false,
    model: 'base',
    language: 'en',
    chunkDuration: 5000,
    bufferDuration: 60,
    activeCount: 0,
    activeSessions: [],
  },
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

function installFetch(opts?: {
  status?: any;
  history?: any;
  activeStream?: any;
}) {
  const statusData = opts?.status ?? STATUS_RESPONSE;
  const historyData = opts?.history ?? HISTORY_RESPONSE;
  const streamData = opts?.activeStream ?? ACTIVE_STREAM_RESPONSE;
  const impl = jest.fn((url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    const method = (options?.method || 'GET').toUpperCase();

    // Order matters: most specific first.
    if (url.endsWith('/admin/transcription/status')) return okJson(statusData);
    if (url.includes('/api/transcriptions/history')) return okJson(historyData);
    if (url.endsWith('/api/stream/active')) return okJson(streamData);
    if (url.endsWith('/admin/transcription/config') && method === 'POST')
      return okJson({ ok: true });
    if (url.endsWith('/admin/transcription/timed') && method === 'POST')
      return okJson({ success: true, sessionId: 'sess-new-1' });
    if (/\/admin\/transcription\/stop\//.test(url)) return okJson({ ok: true });
    if (/\/api\/transcription\//.test(url))
      return okJson({
        id: 'abcdef1234567890',
        full_text: 'Hello world this is a transcript.',
      });

    return okJson({});
  });
  (global as any).fetch = impl;
  return impl;
}

function urlsHit() {
  return fetchCalls.map((c) => c.url);
}

// The component's data-loading useEffect is gated on `socket && connected`, so a
// stub socket with `.on`/`.off` is required for the initial fetch wave to fire.
function makeSocket() {
  return {
    on: jest.fn(),
    off: jest.fn(),
    emit: jest.fn(),
  };
}

const addLog = jest.fn();

beforeEach(() => {
  // CRA's jest preset uses resetMocks:true, which clears the module-factory
  // jest.fn implementation between tests — re-prime getToken + useMainSocket.
  (authService.getToken as jest.Mock).mockReturnValue('test-token');
  (useMainSocket as jest.Mock).mockReturnValue({
    socket: makeSocket(),
    connected: true,
    error: null,
  });
  fetchCalls = [];
  addLog.mockClear();
  localStorage.clear();
  installFetch();
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderLoaded() {
  const result = render(<TranscriptionManagement addLog={addLog} />);
  // Wait for the initial load wave: history row populates from /history.
  await screen.findByText('streamer-7');
  return result;
}

// --- Tests ----------------------------------------------------------------

describe('TranscriptionManagement (characterization)', () => {
  it('renders the header and static section headings on initial mount', async () => {
    await renderLoaded();
    expect(screen.getByText('🎙️ Transcription Management')).toBeInTheDocument();
    expect(screen.getByText('Control Panel')).toBeInTheDocument();
    expect(screen.getByText('Live Transcription')).toBeInTheDocument();
    expect(screen.getByText('Transcription History')).toBeInTheDocument();
  });

  it('fires the initial data-loading fetch wave to the expected endpoints', async () => {
    await renderLoaded();
    const hit = urlsHit();
    expect(hit.some((u) => u.endsWith('/admin/transcription/status'))).toBe(true);
    expect(hit.some((u) => u.includes('/api/transcriptions/history'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/api/stream/active'))).toBe(true);
  });

  it('sends the auth token and admin key in the status fetch headers', async () => {
    localStorage.setItem('adminKey', 'secret-admin-key');
    await renderLoaded();
    const call = fetchCalls.find((c) =>
      c.url.endsWith('/admin/transcription/status')
    );
    const headers = call?.options?.headers as any;
    expect(headers?.Authorization).toBe('Bearer test-token');
    expect(headers?.['x-admin-key']).toBe('secret-admin-key');
  });

  it('reflects loaded config: enable + autoStart checkboxes checked, language select set', async () => {
    await renderLoaded();
    const enable = screen.getByLabelText(
      'Enable Transcription System'
    ) as HTMLInputElement;
    const auto = screen.getByLabelText('Auto-Start on Stream') as HTMLInputElement;
    expect(enable.checked).toBe(true);
    expect(auto.checked).toBe(true);
    // Language select reflects loaded 'es' — the Spanish option is selected.
    expect((screen.getByText('Spanish') as HTMLOptionElement).selected).toBe(true);
  });

  it('renders the loaded active session count and base model in the stats header', async () => {
    await renderLoaded();
    // "Active:" stat shows activeCount from status.
    expect(screen.getByText('Active:').parentElement?.textContent).toContain('1');
    // Model stat is hard-coded to "base".
    const modelStat = screen.getByText('Model:').parentElement;
    expect(modelStat?.textContent).toContain('base');
  });

  it('renders the system status indicators for active stream + enabled system', async () => {
    await renderLoaded();
    expect(screen.getByText('● Stream Active')).toBeInTheDocument();
    expect(screen.getByText('● System Enabled')).toBeInTheDocument();
  });

  it('renders the empty live-transcription placeholder before any transcription', async () => {
    await renderLoaded();
    expect(
      screen.getByText(
        'No active transcription. Start a transcription to see live text here.'
      )
    ).toBeInTheDocument();
  });

  it('renders a history table row from /api/transcriptions/history with truncated id', async () => {
    await renderLoaded();
    // id is truncated to first 8 chars + "..."
    expect(screen.getByText('abcdef12...')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('posts the current config to /admin/transcription/config when clicking Apply Settings', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('Apply Settings'));
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/transcription/config') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('"enable":true');
    });
  });

  it('starts a timed transcription via POST /admin/transcription/timed', async () => {
    installFetch({ status: STATUS_NO_SESSIONS });
    render(<TranscriptionManagement addLog={addLog} />);
    await screen.findByText('streamer-7');
    // The record button label includes the buffer duration (60s from status).
    const btn = screen.getByText(/Record & Transcribe Next/);
    fireEvent.click(btn);
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/admin/transcription/timed') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('streamer-7');
    });
  });

  it('shows the recording status with a Stop Early button after starting', async () => {
    installFetch({ status: STATUS_NO_SESSIONS });
    render(<TranscriptionManagement addLog={addLog} />);
    await screen.findByText('streamer-7');
    fireEvent.click(screen.getByText(/Record & Transcribe Next/));
    await waitFor(() => {
      expect(screen.getByText('Stop Early')).toBeInTheDocument();
    });
    expect(screen.getByText(/Recording\.\.\./)).toBeInTheDocument();
  });

  it('opens the transcript modal and fetches transcript when clicking View in history', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('View'));
    await waitFor(() => {
      expect(
        urlsHit().some((u) => /\/api\/transcription\/abcdef/.test(u))
      ).toBe(true);
    });
    expect(screen.getByText('View Transcript')).toBeInTheDocument();
    expect(
      screen.getByText('Hello world this is a transcript.')
    ).toBeInTheDocument();
  });

  it('toggles the enable checkbox and reflects the new checked state', async () => {
    await renderLoaded();
    const enable = screen.getByLabelText(
      'Enable Transcription System'
    ) as HTMLInputElement;
    expect(enable.checked).toBe(true);
    fireEvent.click(enable);
    expect(enable.checked).toBe(false);
  });

  it('disables the record button when there is no active stream', async () => {
    installFetch({ activeStream: { isActive: false, streamerId: null } });
    render(<TranscriptionManagement addLog={addLog} />);
    await waitFor(() => {
      expect(screen.getByText('● No Active Stream')).toBeInTheDocument();
    });
    const btn = screen.getByText(/Record & Transcribe Next/).closest('button');
    expect(btn).toBeDisabled();
  });

  it('renders the empty history row when no transcriptions are returned', async () => {
    installFetch({ history: { transcriptions: [] } });
    render(<TranscriptionManagement addLog={addLog} />);
    await waitFor(() => {
      expect(screen.getByText('No transcriptions found')).toBeInTheDocument();
    });
  });

  it('renders disabled Clear/Export/Copy actions when live transcription is empty', async () => {
    await renderLoaded();
    const actions = screen
      .getByText('Clear')
      .closest('.transcription-actions') as HTMLElement;
    expect(within(actions).getByText('Clear')).toBeDisabled();
    expect(within(actions).getByText('Export')).toBeDisabled();
    expect(within(actions).getByText('Copy')).toBeDisabled();
  });
});
