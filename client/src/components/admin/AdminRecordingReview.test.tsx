import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import AdminRecordingReview from './AdminRecordingReview';

// AdminRecordingReview loads its data via the `makeApiCall` prop (NOT global
// fetch nor authService data methods). authService.getToken() is only used to
// authenticate HLS segment requests, and hls.js is mocked out below so the
// video pipeline never actually runs in jsdom. The four recording-review child
// components are mocked to keep this a characterization test of THIS component's
// own observable behavior (header, view/filter toggles, data wiring).

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

// hls.js: jsdom has no media element pipeline. Mock it to a no-op so the HLS
// effect runs without throwing. isSupported() returns false so the effect
// short-circuits to the native-playback branch (also a no-op in jsdom).
jest.mock('hls.js', () => {
  const HlsMock: any = jest.fn().mockImplementation(() => ({
    loadSource: jest.fn(),
    attachMedia: jest.fn(),
    detachMedia: jest.fn(),
    destroy: jest.fn(),
    startLoad: jest.fn(),
    recoverMediaError: jest.fn(),
    on: jest.fn(),
  }));
  HlsMock.isSupported = jest.fn(() => false);
  HlsMock.Events = {
    MANIFEST_PARSED: 'hlsManifestParsed',
    BUFFER_APPENDED: 'hlsBufferAppended',
    ERROR: 'hlsError',
  };
  return { __esModule: true, default: HlsMock };
});

// Mock the child sub-views so we can assert THIS component renders them with the
// expected wiring, without pulling in their own fetch/render behavior.
jest.mock('../recording-review/PlaybackTimeline', () => ({
  __esModule: true,
  default: (props: any) => (
    <div data-testid="playback-timeline" data-total={props.totalDurationMs} />
  ),
}));
jest.mock('../recording-review/SyncedChatReplay', () => ({
  __esModule: true,
  default: () => <div data-testid="synced-chat-replay" />,
}));
jest.mock('../recording-review/StreamerList', () => ({
  __esModule: true,
  default: () => <div data-testid="streamer-list" />,
}));
jest.mock('../recording-review/ReviewSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="review-settings">Review Settings View</div>,
}));

// Deterministic fixtures pinning the current data shapes the component consumes.
const EARLIEST = new Date('2025-05-01T10:00:00.000Z').getTime();
const LATEST = new Date('2025-05-01T12:00:00.000Z').getTime();

const PLAYBACK_FIXTURE = {
  sessionIds: ['s1', 's2'],
  sessionCount: 2,
  earliestRecording: EARLIEST,
  latestRecording: LATEST,
  totalDurationMs: 7200000,
  totalChatMessages: 42,
  streamUrl: '/admin/review/stream/master.m3u8',
};

const TIMELINE_FIXTURE = {
  startTime: EARLIEST,
  endTime: LATEST,
  events: [
    {
      id: 'evt-1',
      type: 'real_streamer',
      name: 'CoolStreamer (twitch)',
      platform: 'twitch',
      sourceUrl: 'https://twitch.tv/coolstreamer',
      startTime: EARLIEST,
      endTime: EARLIEST + 3600000,
      duration: 3600000,
      isActive: false,
      color: '#9146ff',
    },
    {
      id: 'evt-2',
      type: 'url_stream',
      name: 'Some URL Stream',
      platform: 'kick',
      sourceUrl: 'https://playback.live-video.net/x',
      startTime: EARLIEST + 3600000,
      endTime: LATEST,
      duration: 3600000,
      isActive: false,
      color: '#53fc18',
    },
  ],
  recordings: [],
};

// Build a makeApiCall mock that routes by endpoint to deterministic responses.
// `hasRecordings` toggles the with/without-recordings rendering branch.
function makeApiCallMock(hasRecordings = true) {
  return jest.fn((endpoint: string) => {
    if (endpoint === '/admin/review/playback') {
      return Promise.resolve({
        success: true,
        hasRecordings,
        playback: PLAYBACK_FIXTURE,
      });
    }
    if (endpoint.startsWith('/admin/review/timeline')) {
      return Promise.resolve({ success: true, timeline: TIMELINE_FIXTURE });
    }
    return Promise.resolve({ success: true });
  });
}

const renderComponent = (hasRecordings = true) => {
  const makeApiCall = makeApiCallMock(hasRecordings);
  const addLog = jest.fn();
  const utils = render(
    <AdminRecordingReview makeApiCall={makeApiCall} addLog={addLog} />
  );
  return { makeApiCall, addLog, ...utils };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AdminRecordingReview (characterization)', () => {
  // 1. Initial render shows the loading spinner before data resolves.
  test('renders the loading spinner on initial mount', () => {
    renderComponent();
    expect(screen.getByText('Loading recordings...')).toBeInTheDocument();
  });

  // 2. On mount it fetches both the playback info and 7-day timeline endpoints.
  test('fetches playback info and timeline on mount', async () => {
    const { makeApiCall } = renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(makeApiCall).toHaveBeenCalledWith('/admin/review/playback');
    expect(makeApiCall).toHaveBeenCalledWith('/admin/review/timeline?days=7');
  });

  // 3. After load, the header bar + recording info (chat message count) appear.
  test('renders header bar and recording info after load', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByText(/42 chat messages/)).toBeInTheDocument();
  });

  // 4. Header action buttons are present after load.
  test('renders the header action buttons', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'All Data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide Streamers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide Chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  // 5. With recordings, the player layout renders the timeline + both sidebars.
  test('renders the player layout with timeline and both sidebars', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByTestId('playback-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('streamer-list')).toBeInTheDocument();
    expect(screen.getByTestId('synced-chat-replay')).toBeInTheDocument();
    // Total duration is forwarded from the playback fixture (ms).
    expect(screen.getByTestId('playback-timeline')).toHaveAttribute(
      'data-total',
      '7200000'
    );
  });

  // 6. The playback info bar shows the formatted total duration (2:00:00).
  test('renders the total duration in the playback info bar', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByText('2:00:00')).toBeInTheDocument();
    expect(screen.getByText(/Paused/)).toBeInTheDocument();
  });

  // 7. Toggling the time-filter button reveals the preset filter bar.
  test('toggling the filter button reveals the time-filter presets', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    // Preset buttons are hidden initially.
    expect(screen.queryByRole('button', { name: 'Last Hour' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'All Data' }));

    expect(screen.getByRole('button', { name: 'Last Hour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 6 Hours' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Custom' })).toBeInTheDocument();
  });

  // 8. Choosing a preset updates the header label and shows a filter summary.
  test('selecting a preset updates the header label and shows a summary', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'All Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Last 24 Hours' }));

    // Header label reflects the active preset.
    const header = document.querySelector('.header-right') as HTMLElement;
    expect(
      within(header).getByText('Last 24 Hours')
    ).toBeInTheDocument();
    // Filter summary appears once a non-"all" preset is active.
    expect(screen.getByText(/Showing \d+ events/)).toBeInTheDocument();
  });

  // 9. The Custom preset reveals the From/To datetime inputs.
  test('the Custom preset reveals custom date inputs', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'All Data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));

    expect(screen.getByText('From:')).toBeInTheDocument();
    expect(screen.getByText('To:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  // 10. The Settings header button swaps to the ReviewSettings view.
  test('clicking Settings switches to the settings view', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    // Player layout is showing first.
    expect(screen.getByTestId('playback-timeline')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(screen.getByTestId('review-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('playback-timeline')).not.toBeInTheDocument();
  });

  // 11. Toggling "Hide Chat" removes the chat sidebar and flips the label.
  test('toggling the chat button hides the chat sidebar', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByTestId('synced-chat-replay')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Chat' }));

    expect(screen.queryByTestId('synced-chat-replay')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Chat' })).toBeInTheDocument();
  });

  // 12. Toggling "Hide Streamers" removes the streamer sidebar and flips label.
  test('toggling the streamers button hides the streamer sidebar', async () => {
    renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    expect(screen.getByTestId('streamer-list')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Streamers' }));

    expect(screen.queryByTestId('streamer-list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Streamers' })).toBeInTheDocument();
  });

  // 13. The Refresh button re-invokes the playback endpoint.
  test('the Refresh button re-fetches playback info', async () => {
    const { makeApiCall } = renderComponent();
    await waitFor(() =>
      expect(screen.getByText('Recording Review')).toBeInTheDocument()
    );
    const before = makeApiCall.mock.calls.filter(
      (c: any[]) => c[0] === '/admin/review/playback'
    ).length;

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => {
      const after = makeApiCall.mock.calls.filter(
        (c: any[]) => c[0] === '/admin/review/playback'
      ).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  // 14. When the API reports no recordings, the empty state renders instead.
  test('renders the no-recordings empty state when there are no recordings', async () => {
    renderComponent(false);
    await waitFor(() =>
      expect(screen.getByText('No Recordings Available')).toBeInTheDocument()
    );
    expect(
      screen.getByText('Recording data will appear here once streams are captured.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Again' })).toBeInTheDocument();
    // No player timeline in this branch.
    expect(screen.queryByTestId('playback-timeline')).not.toBeInTheDocument();
  });
});
