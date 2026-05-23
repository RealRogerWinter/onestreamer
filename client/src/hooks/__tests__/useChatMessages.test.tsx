import { act, renderHook } from '@testing-library/react';
import { useChatMessages, ChatMessage } from '../useChatMessages';

// ---------------------------------------------------------------------------
// sessionStorage mock
// ---------------------------------------------------------------------------
// jsdom's `window.sessionStorage` is exposed via a getter on the Window
// prototype that returns an internal Storage instance — once that instance
// exists, Object.defineProperty(window, 'sessionStorage', ...) doesn't reliably
// shadow it across tests. Instead, we spy on the Storage prototype methods
// and back them with a per-test in-memory map. This is the pattern that works
// consistently inside react-scripts' jsdom environment.

let store: Record<string, string>;
let getItemSpy: jest.SpyInstance;
let setItemSpy: jest.SpyInstance;
let removeItemSpy: jest.SpyInstance;
let clearSpy: jest.SpyInstance;

beforeEach(() => {
  store = {};
  getItemSpy = jest
    .spyOn(Storage.prototype, 'getItem')
    .mockImplementation((key: string) => (key in store ? store[key] : null));
  setItemSpy = jest
    .spyOn(Storage.prototype, 'setItem')
    .mockImplementation((key: string, value: string) => {
      store[key] = String(value);
    });
  removeItemSpy = jest
    .spyOn(Storage.prototype, 'removeItem')
    .mockImplementation((key: string) => {
      delete store[key];
    });
  clearSpy = jest.spyOn(Storage.prototype, 'clear').mockImplementation(() => {
    store = {};
  });
});

afterEach(() => {
  getItemSpy.mockRestore();
  setItemSpy.mockRestore();
  removeItemSpy.mockRestore();
  clearSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: overrides.id ?? 'msg-1',
    username: 'alice',
    color: '#fff',
    message: 'hello',
    timestamp: '12:00',
    fullTimestamp: '2026-05-23T12:00:00.000Z',
    userId: 'u-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChatMessages', () => {
  it('initial state: messages=[], messageHistory=[], historyIndex=-1', () => {
    const { result } = renderHook(() => useChatMessages());

    expect(result.current.messages).toEqual([]);
    expect(result.current.messageHistory).toEqual([]);
    expect(result.current.historyIndex).toBe(-1);
  });

  it('reads sessionStorage on mount and restores stored messages', () => {
    const stored: ChatMessage[] = [makeMessage({ id: 'a' }), makeMessage({ id: 'b' })];
    // Seed via the underlying store so the read happens through the spy.
    store['chatMessages'] = JSON.stringify(stored);
    getItemSpy.mockClear();

    const { result } = renderHook(() => useChatMessages());

    expect(getItemSpy).toHaveBeenCalledWith('chatMessages');
    expect(result.current.messages).toEqual(stored);
  });

  it('tolerates malformed JSON in sessionStorage (falls back to empty)', () => {
    store['chatMessages'] = '{not json';

    const { result } = renderHook(() => useChatMessages());

    expect(result.current.messages).toEqual([]);
  });

  it('addMessage appends to the messages array', () => {
    const { result } = renderHook(() => useChatMessages());

    const m1 = makeMessage({ id: '1' });
    const m2 = makeMessage({ id: '2' });

    act(() => {
      result.current.addMessage(m1);
    });
    act(() => {
      result.current.addMessage(m2);
    });

    expect(result.current.messages).toEqual([m1, m2]);
  });

  it('removeMessages filters out messages by id', () => {
    const { result } = renderHook(() => useChatMessages());

    const m1 = makeMessage({ id: '1' });
    const m2 = makeMessage({ id: '2' });
    const m3 = makeMessage({ id: '3' });

    act(() => {
      result.current.replaceMessages([m1, m2, m3]);
    });
    act(() => {
      result.current.removeMessages(['1', '3']);
    });

    expect(result.current.messages).toEqual([m2]);
  });

  it('removeMessages is a no-op for empty id list', () => {
    const { result } = renderHook(() => useChatMessages());

    const m1 = makeMessage({ id: '1' });
    act(() => {
      result.current.replaceMessages([m1]);
    });
    act(() => {
      result.current.removeMessages([]);
    });
    expect(result.current.messages).toEqual([m1]);
  });

  it('clearMessages empties the array', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.replaceMessages([makeMessage({ id: '1' }), makeMessage({ id: '2' })]);
    });
    expect(result.current.messages).toHaveLength(2);

    act(() => {
      result.current.clearMessages();
    });
    expect(result.current.messages).toEqual([]);
  });

  it('replaceMessages overwrites the existing list', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.addMessage(makeMessage({ id: 'old' }));
    });
    const replacement = [makeMessage({ id: 'new-1' }), makeMessage({ id: 'new-2' })];
    act(() => {
      result.current.replaceMessages(replacement);
    });

    expect(result.current.messages).toEqual(replacement);
  });

  it('pushHistory prepends, dedups consecutive duplicates, and caps at 50 entries', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.pushHistory('hello');
    });
    act(() => {
      // duplicate of head -> ignored
      result.current.pushHistory('hello');
    });
    act(() => {
      result.current.pushHistory('world');
    });

    expect(result.current.messageHistory).toEqual(['world', 'hello']);

    // Push 60 distinct entries; the list should cap at 50 (newest first).
    act(() => {
      for (let i = 0; i < 60; i++) {
        result.current.pushHistory(`m${i}`);
      }
    });

    expect(result.current.messageHistory).toHaveLength(50);
    // Newest entry pushed last -> at index 0
    expect(result.current.messageHistory[0]).toBe('m59');
    // 50th-newest entry is m10 (m59 .. m10 = 50 items)
    expect(result.current.messageHistory[49]).toBe('m10');
  });

  it('historyPrev returns {index, message} when history non-empty, advances index', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      // After these pushes, history is ['second', 'first']
      result.current.pushHistory('first');
      result.current.pushHistory('second');
    });

    let prev: { index: number; message: string } | null = null;
    act(() => {
      prev = result.current.historyPrev();
    });
    expect(prev).toEqual({ index: 0, message: 'second' });
    expect(result.current.historyIndex).toBe(0);

    act(() => {
      prev = result.current.historyPrev();
    });
    expect(prev).toEqual({ index: 1, message: 'first' });
    expect(result.current.historyIndex).toBe(1);

    // Already at oldest entry; further calls clamp and keep returning the
    // same entry (newIndex === length-1 stays in range).
    act(() => {
      prev = result.current.historyPrev();
    });
    expect(prev).toEqual({ index: 1, message: 'first' });
  });

  it('historyPrev returns null when there is no history', () => {
    const { result } = renderHook(() => useChatMessages());

    let prev: { index: number; message: string } | null = { index: 99, message: 'sentinel' };
    act(() => {
      prev = result.current.historyPrev();
    });
    expect(prev).toBeNull();
    expect(result.current.historyIndex).toBe(-1);
  });

  it('historyNext steps back toward newest, then resets to -1 at the end', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.pushHistory('first');
      result.current.pushHistory('second');
      result.current.pushHistory('third');
    });
    // history = ['third','second','first']

    // Two separate acts so each setHistoryIndex commit is flushed before the
    // next callback reads `historyIndex` via the dependency-array closure.
    act(() => {
      result.current.historyPrev(); // index -1 -> 0 -> 'third'
    });
    act(() => {
      result.current.historyPrev(); // index 0 -> 1 -> 'second'
    });
    expect(result.current.historyIndex).toBe(1);

    let next: { index: number; message: string } | null = null;
    act(() => {
      next = result.current.historyNext();
    });
    expect(next).toEqual({ index: 0, message: 'third' });
    expect(result.current.historyIndex).toBe(0);

    // Stepping past the newest entry returns null and resets the index to -1.
    act(() => {
      next = result.current.historyNext();
    });
    expect(next).toBeNull();
    expect(result.current.historyIndex).toBe(-1);
  });

  it('historyNext returns null when not browsing (historyIndex < 0)', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.pushHistory('only');
    });

    let next: { index: number; message: string } | null = { index: 99, message: 'sentinel' };
    act(() => {
      next = result.current.historyNext();
    });
    expect(next).toBeNull();
    expect(result.current.historyIndex).toBe(-1);
  });

  it('resetHistoryIndex sets index back to -1', () => {
    const { result } = renderHook(() => useChatMessages());

    act(() => {
      result.current.pushHistory('a');
      result.current.pushHistory('b');
    });
    act(() => {
      result.current.historyPrev();
    });
    expect(result.current.historyIndex).toBeGreaterThanOrEqual(0);

    act(() => {
      result.current.resetHistoryIndex();
    });
    expect(result.current.historyIndex).toBe(-1);
  });

  it('persists messages to sessionStorage on every change', () => {
    const { result } = renderHook(() => useChatMessages());
    // Initial mount effect writes [].
    expect(setItemSpy).toHaveBeenCalledWith('chatMessages', JSON.stringify([]));

    const m1 = makeMessage({ id: 'p1' });
    act(() => {
      result.current.addMessage(m1);
    });

    expect(setItemSpy).toHaveBeenLastCalledWith('chatMessages', JSON.stringify([m1]));

    act(() => {
      result.current.clearMessages();
    });
    expect(setItemSpy).toHaveBeenLastCalledWith('chatMessages', JSON.stringify([]));
  });

  it('ChatMessage type re-export is usable from the hook module', () => {
    // Compile-time check: this assignment relies on `ChatMessage` being
    // exported from the hook module.
    const sample: ChatMessage = makeMessage({ id: 'type-test' });
    expect(sample.id).toBe('type-test');
  });
});
