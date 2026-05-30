import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TutorialEditor from './TutorialEditor';
import authService from '../../services/AuthService';

// TutorialEditor loads/saves its tabbed Help/Tutorial markdown via the global
// `fetch()` API:
//   - GET  `${API_URL}/api/tutorial`  on mount (NO auth header)
//   - POST `${API_URL}/api/tutorial`  on Save, with
//       `Authorization: Bearer <authService.getToken()>` and body `{ tabs }`.
// The only prop is `addLog`. These characterization tests pin the CURRENT
// observable behavior by mocking authService + a fetch mock, then asserting the
// rendered DOM, tab/mode switching, editing, and the save endpoint + payload.
// API_URL resolves to '' in the test env (no REACT_APP_API_URL), so the URLs
// are exactly '/api/tutorial'.

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getToken: jest.fn(() => 'test-token'),
  },
}));

const TABS_FIXTURE = {
  about: '# About Heading\n\nAbout body.',
  support: '# Support Heading\n\nSupport body.',
  tutorial: '# Tutorial Heading\n\nTutorial body.',
  terms: '# Terms Heading\n\nTerms body.',
  privacy: '# Privacy Heading\n\nPrivacy body.',
};

const okGet = (body: any) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (authService.getToken as jest.Mock).mockReturnValue('test-token');
  fetchMock = jest.fn((url: string, opts?: RequestInit) => {
    if (opts && opts.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    }
    // default GET returns saved tabs
    return okGet({ tabs: TABS_FIXTURE });
  });
  // @ts-ignore
  global.fetch = fetchMock;
});

const renderLoaded = async (addLog = jest.fn()) => {
  render(<TutorialEditor addLog={addLog} />);
  await waitFor(() =>
    expect(screen.queryByText('Loading tutorial content...')).not.toBeInTheDocument()
  );
  return addLog;
};

describe('TutorialEditor — characterization', () => {
  test('1: shows loading state then fetches GET /api/tutorial on mount', async () => {
    const addLog = jest.fn();
    render(<TutorialEditor addLog={addLog} />);
    // loading message visible initially
    expect(screen.getByText('Loading tutorial content...')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Loading tutorial content...')).not.toBeInTheDocument()
    );
    const getCall = fetchMock.mock.calls.find((c) => !c[1] || c[1].method !== 'POST');
    expect(getCall).toBeTruthy();
    expect(getCall![0]).toBe('/api/tutorial');
  });

  test('2: renders header and the five content tabs after load', async () => {
    await renderLoaded();
    expect(screen.getByText('📚 Tutorial & Help Editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tutorial' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Privacy' })).toBeInTheDocument();
  });

  test('3: defaults to the Tutorial tab active and shows its content in the textarea', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: 'Tutorial' })).toHaveClass('active');
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe(TABS_FIXTURE.tutorial);
    expect(textarea).toHaveAttribute('placeholder', 'Write your tutorial content in Markdown format...');
  });

  test('4: addLog is called on successful load', async () => {
    const addLog = await renderLoaded();
    expect(addLog).toHaveBeenCalledWith('Tutorial content loaded successfully');
  });

  test('5: switching tabs updates active class and textarea content + placeholder', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'About' }));
    expect(screen.getByRole('button', { name: 'About' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Tutorial' })).not.toHaveClass('active');
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe(TABS_FIXTURE.about);
    expect(textarea).toHaveAttribute('placeholder', 'Write your about content in Markdown format...');
  });

  test('6: editing the textarea updates the displayed content', async () => {
    await renderLoaded();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '# Edited tutorial' } });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('# Edited tutorial');
  });

  test('7: edits are isolated per-tab', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'CHANGED TUTORIAL' } });
    fireEvent.click(screen.getByRole('button', { name: 'Terms' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(TABS_FIXTURE.terms);
    fireEvent.click(screen.getByRole('button', { name: 'Tutorial' }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('CHANGED TUTORIAL');
  });

  test('8: Preview toggle hides the textarea and renders parsed markdown', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '👁️ Preview' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // tutorial fixture starts with "# Tutorial Heading" -> an <h1>
    expect(screen.getByRole('heading', { level: 1, name: 'Tutorial Heading' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '👁️ Preview' })).toHaveClass('active');
  });

  test('9: Edit toggle returns to the textarea', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '👁️ Preview' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '✏️ Edit' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✏️ Edit' })).toHaveClass('active');
  });

  test('10: Save All POSTs to /api/tutorial with bearer token and { tabs } payload', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'NEW TUTORIAL BODY' } });
    fireEvent.click(screen.getByRole('button', { name: '💾 Save All' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => c[1] && c[1].method === 'POST');
      expect(post).toBeTruthy();
    });
    const post = fetchMock.mock.calls.find((c) => c[1] && c[1].method === 'POST')!;
    expect(post[0]).toBe('/api/tutorial');
    expect(post[1].headers['Content-Type']).toBe('application/json');
    expect(post[1].headers['Authorization']).toBe('Bearer test-token');
    const body = JSON.parse(post[1].body);
    expect(body.tabs.tutorial).toBe('NEW TUTORIAL BODY');
    expect(body.tabs).toHaveProperty('about');
    expect(body.tabs).toHaveProperty('privacy');
  });

  test('11: successful save logs success and shows a Last saved line', async () => {
    const addLog = await renderLoaded();
    expect(screen.queryByText(/Last saved:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '💾 Save All' }));
    await waitFor(() =>
      expect(addLog).toHaveBeenCalledWith('Tutorial content saved successfully')
    );
    expect(screen.getByText(/Last saved:/)).toBeInTheDocument();
  });

  test('12: a failed GET (response not ok) falls back to default content and logs it', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response)
    );
    const addLog = jest.fn();
    render(<TutorialEditor addLog={addLog} />);
    await waitFor(() =>
      expect(screen.queryByText('Loading tutorial content...')).not.toBeInTheDocument()
    );
    expect(addLog).toHaveBeenCalledWith('Using default tutorial content (no saved content found)');
    // default tutorial content contains this heading text
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toContain('# Tutorial Guide');
  });

  test('13: a failed save (response not ok) logs the server error message', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts && opts.method === 'POST') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'boom' }),
        } as Response);
      }
      return okGet({ tabs: TABS_FIXTURE });
    });
    const addLog = await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: '💾 Save All' }));
    await waitFor(() => expect(addLog).toHaveBeenCalledWith('Failed to save tutorial: boom'));
  });

  test('14: when GET returns legacy { content } shape, tutorial tab uses it', async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (opts && opts.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
      }
      return okGet({ content: 'LEGACY SINGLE CONTENT' });
    });
    await renderLoaded();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('LEGACY SINGLE CONTENT');
  });
});
