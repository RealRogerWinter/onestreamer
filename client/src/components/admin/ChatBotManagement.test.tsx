import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ChatBotManagement from './ChatBotManagement';
import authService from '../../services/AuthService';

// ChatBotManagement loads ALL of its data via the global `fetch()` API,
// authenticating with `Authorization: Bearer <authService.getToken()>` (and an
// extra `x-admin-key` header read from localStorage for the MovieBot/Groq admin
// endpoints). There is no makeApiCall prop and no socket — the only prop is
// `addLog`. These characterization tests pin the CURRENT observable behavior by
// mocking authService + a URL-routing fetch mock, then asserting the rendered
// DOM and which endpoints each interaction hits.

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

// --- Fixtures -------------------------------------------------------------

const SYSTEM_BOT = {
  id: 1,
  name: 'AlphaBot',
  prompt: 'You are a friendly and engaging chat participant who loves the stream and chats a lot here.',
  is_enabled: true,
  response_interval_min: 60,
  response_interval_max: 180,
  show_robot_emoji: true,
  use_assigned_name: true,
  llm_model: 'mistral',
  personality_traits: {
    enthusiasm: true,
    casual: true,
    supportive: false,
    humorous: false,
    curious: false,
    temperature: 0.7,
  },
  is_connected: true,
  moviebot_enabled: false,
  last_message: 'Hello chat!',
  last_message_at: new Date().toISOString(),
  is_temporary: false,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const TEMP_BOT = {
  id: 2,
  name: 'SummonedBuddy',
  prompt: 'A user summoned me to be chaotic and fun in this stream chat right now.',
  is_enabled: false,
  response_interval_min: 30,
  response_interval_max: 90,
  show_robot_emoji: false,
  use_assigned_name: false,
  is_connected: false,
  is_temporary: true,
  summoned_by: 'cooluser42',
  personality_prompt: 'Make it spooky',
  time_remaining_display: '12m 30s',
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-01T00:00:00.000Z',
};

const MODELS_RESPONSE = {
  available: [
    { name: 'mistral', displayName: 'Mistral 7B', size: '4.1 GB' },
    { name: 'llama3.2:1b', displayName: 'Llama 3.2 1B', size: '1.3 GB' },
  ],
  current: { name: 'mistral', info: { displayName: 'Mistral 7B', size: '4.1 GB' } },
};

const LLM_STATUS = { available: true, model: 'mistral', host: 'localhost' };

const MOVIEBOT_STATUS = {
  enabled: false,
  isActive: false,
  currentStreamerId: null,
  config: {
    transcriptionDuration: 45,
    minInterval: 30000,
    maxInterval: 60000,
    chatHistoryLimit: 30,
    transcriptionFrequency: 120,
    useGroq: false,
  },
  recentPrompts: [],
};

const GROQ_STATUS = {
  enabled: false,
  model: 'llama-3.1-8b-instant',
  hasApiKey: false,
  availableModels: [],
};

const CONFIG_RESPONSE = { global_prompt: 'Be nice to everyone.' };

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

function installFetch(bots: any[] = [SYSTEM_BOT, TEMP_BOT]) {
  const impl = jest.fn((url: string, options?: RequestInit) => {
    fetchCalls.push({ url, options });
    const method = (options?.method || 'GET').toUpperCase();

    // Order matters: most specific first.
    if (url.endsWith('/api/chatbots/config')) return okJson(CONFIG_RESPONSE);
    if (url.endsWith('/api/chatbots/models')) {
      if (method === 'PUT') return okJson({ available: true });
      return okJson(MODELS_RESPONSE);
    }
    if (url.endsWith('/api/chatbots/llm-status')) return okJson(LLM_STATUS);
    if (url.endsWith('/api/chatbots/all/enable')) return okJson({ count: bots.length });
    if (url.endsWith('/api/chatbots/all/disable')) return okJson({ count: bots.length });
    if (/\/api\/chatbots\/\d+\/toggle$/.test(url))
      return okJson({ name: 'AlphaBot', is_enabled: false });
    if (/\/api\/chatbots\/\d+\/test$/.test(url))
      return okJson({ bot_name: 'AlphaBot', response: 'hi there', context: [] });
    if (/\/api\/chatbots\/\d+\/send$/.test(url))
      return okJson({ bot_name: 'AlphaBot', message: 'generated' });
    if (/\/api\/chatbots\/\d+\/history$/.test(url)) return okJson([]);
    if (/\/api\/chatbots\/\d+\/extend-time$/.test(url))
      return okJson({ expires_at: '2025-01-01T01:00:00.000Z' });
    if (/\/api\/chatbots\/\d+$/.test(url)) {
      if (method === 'DELETE') return okJson({});
      if (method === 'PUT') return okJson({ name: 'AlphaBot', moviebot_enabled: true });
    }
    if (url.endsWith('/api/chatbots')) {
      if (method === 'POST') return okJson({ name: 'NewBot' });
      return okJson(bots);
    }

    // Admin (MovieBot / Groq) endpoints.
    if (url.endsWith('/admin/moviebot/status')) return okJson(MOVIEBOT_STATUS);
    if (url.endsWith('/admin/moviebot/enable')) return okJson({ ok: true });
    if (url.endsWith('/admin/moviebot/disable')) return okJson({ ok: true });
    if (url.endsWith('/admin/moviebot/config')) return okJson({ ok: true });
    if (url.includes('/admin/moviebot/logs')) return okJson({ logs: [] });
    if (url.endsWith('/admin/groq/status')) return okJson(GROQ_STATUS);
    if (url.endsWith('/admin/groq/config')) return okJson({ ok: true });

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
  installFetch();
  jest.spyOn(window, 'confirm').mockImplementation(() => true);
  jest.spyOn(window, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function renderLoaded() {
  const result = render(<ChatBotManagement addLog={addLog} />);
  // Wait for the bot list to populate from the initial fetch wave. The bot-name
  // span holds two text nodes ("🤖 " + the name), so match on element text
  // content with a substring matcher.
  await screen.findByText((_c, el) => el?.className === 'bot-name' && /AlphaBot/.test(el.textContent || ''));
  return result;
}

// The `.bot-name` span concatenates an optional robot emoji with the name, so a
// plain getByText('AlphaBot') won't match the element. This helper finds the
// enclosing .bot-card for a given bot name.
function botCard(name: string): HTMLElement {
  const nameEl = screen.getAllByText(
    (_c, el) => el?.className === 'bot-name' && new RegExp(name).test(el.textContent || '')
  )[0];
  return nameEl.closest('.bot-card') as HTMLElement;
}

// --- Tests ----------------------------------------------------------------

describe('ChatBotManagement (characterization)', () => {
  it('renders the major static section headings on initial mount', async () => {
    await renderLoaded();
    expect(screen.getByText('LLM Status')).toBeInTheDocument();
    expect(screen.getByText('LLM Model Selection')).toBeInTheDocument();
    expect(screen.getByText('Global Prompt (Applied to All Bots)')).toBeInTheDocument();
    expect(screen.getByText('🎬 MovieBot - AI Film Commentary')).toBeInTheDocument();
  });

  it('fires the initial data-loading fetch wave to the expected endpoints', async () => {
    await renderLoaded();
    const hit = urlsHit();
    expect(hit.some((u) => u.endsWith('/api/chatbots'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/api/chatbots/llm-status'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/api/chatbots/config'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/api/chatbots/models'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/admin/moviebot/status'))).toBe(true);
    expect(hit.some((u) => u.endsWith('/admin/groq/status'))).toBe(true);
  });

  it('sends the auth token in the chatbots fetch headers', async () => {
    await renderLoaded();
    const call = fetchCalls.find((c) => c.url.endsWith('/api/chatbots'));
    expect((call?.options?.headers as any)?.Authorization).toBe('Bearer test-token');
  });

  it('renders the LLM status indicator as Connected with the model name', async () => {
    await renderLoaded();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Model: mistral')).toBeInTheDocument();
  });

  it('renders the global prompt text from /api/chatbots/config', async () => {
    await renderLoaded();
    expect(screen.getByText('Be nice to everyone.')).toBeInTheDocument();
  });

  it('renders both a System Bots section and a User-Summoned Bots section', async () => {
    await renderLoaded();
    expect(screen.getByText('🤖 System Bots')).toBeInTheDocument();
    expect(screen.getByText('🤖 User-Summoned Bots')).toBeInTheDocument();
    // Header count reflects total chatbots.
    expect(screen.getByText('Chatbots (2)')).toBeInTheDocument();
  });

  it('renders a system bot card with name, model badge, and last message', async () => {
    await renderLoaded();
    expect(botCard('AlphaBot')).toBeInTheDocument();
    expect(screen.getByText('mistral')).toBeInTheDocument();
    expect(screen.getByText('Hello chat!')).toBeInTheDocument();
    // Enthusiastic + Casual traits pinned.
    expect(screen.getByText('Enthusiastic')).toBeInTheDocument();
    expect(screen.getByText('Casual')).toBeInTheDocument();
  });

  it('renders a summoned bot card with summoner and time remaining', async () => {
    await renderLoaded();
    expect(botCard('SummonedBuddy')).toBeInTheDocument();
    expect(screen.getByText('cooluser42')).toBeInTheDocument();
    expect(screen.getByText('12m 30s')).toBeInTheDocument();
    expect(screen.getByText('Make it spooky')).toBeInTheDocument();
  });

  it('opens the create form with default fields when clicking "+ Create New Bot"', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('+ Create New Bot'));
    expect(screen.getByText('Create New Chatbot')).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('e.g., FriendlyBot or leave empty for Lion1234')
    ).toBeInTheDocument();
    // Prompt template buttons render inside the form.
    expect(screen.getByText('Friendly Viewer')).toBeInTheDocument();
    expect(screen.getByText('Meme Lord')).toBeInTheDocument();
  });

  it('submits a create request to POST /api/chatbots from the create form', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('+ Create New Bot'));
    const nameInput = screen.getByPlaceholderText(
      'e.g., FriendlyBot or leave empty for Lion1234'
    );
    fireEvent.change(nameInput, { target: { value: 'TestBot' } });
    fireEvent.click(screen.getByText('Create'));
    await waitFor(() => {
      const post = fetchCalls.find(
        (c) =>
          c.url.endsWith('/api/chatbots') &&
          (c.options?.method || '').toUpperCase() === 'POST'
      );
      expect(post).toBeDefined();
      expect(post!.options!.body as string).toContain('TestBot');
    });
  });

  it('opens the edit form pre-filled when clicking Edit on a system bot', async () => {
    await renderLoaded();
    // Find the system bot card and click its Edit button.
    const card = botCard('AlphaBot');
    fireEvent.click(within(card).getByText('Edit'));
    expect(screen.getByText('Edit Chatbot')).toBeInTheDocument();
    expect((screen.getByDisplayValue('AlphaBot') as HTMLInputElement).value).toBe('AlphaBot');
  });

  it('toggles a system bot via POST /api/chatbots/:id/toggle', async () => {
    await renderLoaded();
    const card = botCard('AlphaBot');
    fireEvent.click(within(card).getByText('Disable'));
    await waitFor(() => {
      expect(urlsHit().some((u) => /\/api\/chatbots\/1\/toggle$/.test(u))).toBe(true);
    });
  });

  it('deletes a system bot via DELETE /api/chatbots/:id after confirm', async () => {
    await renderLoaded();
    const card = botCard('AlphaBot');
    fireEvent.click(within(card).getByText('Delete'));
    await waitFor(() => {
      const del = fetchCalls.find(
        (c) =>
          /\/api\/chatbots\/1$/.test(c.url) &&
          (c.options?.method || '').toUpperCase() === 'DELETE'
      );
      expect(del).toBeDefined();
    });
    expect(window.confirm).toHaveBeenCalled();
  });

  it('enables all bots via POST /api/chatbots/all/enable', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('✅ Enable All'));
    await waitFor(() => {
      expect(urlsHit().some((u) => u.endsWith('/api/chatbots/all/enable'))).toBe(true);
    });
  });

  it('opens the MovieBot logs modal and fetches logs when clicking View Live Prompt Logs', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('📋 View Live Prompt Logs'));
    expect(screen.getByText('🎬 MovieBot Live Prompt Logs')).toBeInTheDocument();
    await waitFor(() => {
      expect(urlsHit().some((u) => u.includes('/admin/moviebot/logs'))).toBe(true);
    });
  });

  it('enters edit mode for the global prompt and saves via PUT /api/chatbots/config', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByText('Edit Global Prompt'));
    const textarea = screen.getByPlaceholderText(
      /Enter the global prompt that will be prepended/
    );
    fireEvent.change(textarea, { target: { value: 'New global prompt' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => {
      const put = fetchCalls.find(
        (c) =>
          c.url.endsWith('/api/chatbots/config') &&
          (c.options?.method || '').toUpperCase() === 'PUT'
      );
      expect(put).toBeDefined();
      expect(put!.options!.body as string).toContain('New global prompt');
    });
  });

  it('renders the empty state with zero bots and no bot sections', async () => {
    installFetch([]);
    render(<ChatBotManagement addLog={addLog} />);
    await waitFor(() => {
      expect(screen.getByText('Chatbots (0)')).toBeInTheDocument();
    });
    expect(screen.queryByText('🤖 System Bots')).not.toBeInTheDocument();
    expect(screen.queryByText('🤖 User-Summoned Bots')).not.toBeInTheDocument();
  });
});
