import React from 'react';
import { render, act } from '@testing-library/react';
import { useResponsiveLayout } from '../useResponsiveLayout';

// Probe component that exposes the hook's return value via DOM attrs
// so the assertions don't depend on rendering text content.
function Probe({ onState }: { onState: (s: { isMobile: boolean; isLandscape: boolean }) => void }) {
  const state = useResponsiveLayout();
  onState(state);
  return (
    <div
      data-testid="probe"
      data-is-mobile={String(state.isMobile)}
      data-is-landscape={String(state.isLandscape)}
    />
  );
}

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height });
}

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', {
    configurable: true,
    get: () => ua,
  });
}

describe('useResponsiveLayout', () => {
  // Snapshot originals so we can restore between tests
  const origWidth = window.innerWidth;
  const origHeight = window.innerHeight;
  const origUA = window.navigator.userAgent;

  afterEach(() => {
    setViewport(origWidth, origHeight);
    setUserAgent(origUA);
    jest.restoreAllMocks();
  });

  it('desktop viewport + desktop UA -> isMobile=false, isLandscape=false', () => {
    setViewport(1920, 1080);
    setUserAgent(DESKTOP_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    render(<Probe onState={(s) => { captured = s; }} />);

    expect(captured).not.toBeNull();
    expect(captured!.isMobile).toBe(false);
    expect(captured!.isLandscape).toBe(false);
  });

  it('iPhone portrait viewport + iPhone UA -> isMobile=true, isLandscape=false', () => {
    setViewport(375, 812);
    setUserAgent(IPHONE_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    render(<Probe onState={(s) => { captured = s; }} />);

    expect(captured!.isMobile).toBe(true);
    expect(captured!.isLandscape).toBe(false);
  });

  it('iPhone landscape viewport + iPhone UA -> isMobile=true, isLandscape=true', () => {
    setViewport(812, 375);
    setUserAgent(IPHONE_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    render(<Probe onState={(s) => { captured = s; }} />);

    expect(captured!.isMobile).toBe(true);
    expect(captured!.isLandscape).toBe(true);
  });

  it('resize event flips state from desktop to mobile (<=768 width)', () => {
    setViewport(1920, 1080);
    setUserAgent(DESKTOP_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    render(<Probe onState={(s) => { captured = s; }} />);
    expect(captured!.isMobile).toBe(false);

    // Shrink to mobile width and dispatch resize
    act(() => {
      setViewport(500, 900);
      window.dispatchEvent(new Event('resize'));
    });

    expect(captured!.isMobile).toBe(true);
    expect(captured!.isLandscape).toBe(false); // 500 < 900
  });

  it('orientationchange event flips landscape on mobile', () => {
    setViewport(375, 812);
    setUserAgent(IPHONE_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    render(<Probe onState={(s) => { captured = s; }} />);
    expect(captured!.isLandscape).toBe(false);

    act(() => {
      setViewport(812, 375); // rotate to landscape
      window.dispatchEvent(new Event('orientationchange'));
    });

    expect(captured!.isMobile).toBe(true);
    expect(captured!.isLandscape).toBe(true);
  });

  it('unmount removes resize and orientationchange listeners', () => {
    setViewport(1920, 1080);
    setUserAgent(DESKTOP_UA);

    const removeSpy = jest.spyOn(window, 'removeEventListener');

    const { unmount } = render(<Probe onState={() => {}} />);
    unmount();

    const removedEvents = removeSpy.mock.calls.map((call) => call[0]);
    expect(removedEvents).toContain('resize');
    expect(removedEvents).toContain('orientationchange');
  });

  it('post-unmount events do not throw and do not mutate stale state', () => {
    setViewport(1920, 1080);
    setUserAgent(DESKTOP_UA);

    let captured: { isMobile: boolean; isLandscape: boolean } | null = null;
    const { unmount } = render(<Probe onState={(s) => { captured = s; }} />);
    const snapshot = { ...captured! };

    unmount();

    // After unmount, listeners should be detached; dispatching shouldn't
    // call our probe again or throw.
    expect(() => {
      setViewport(400, 800);
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
    }).not.toThrow();

    // Captured state should equal the pre-unmount snapshot (no further renders).
    expect(captured).toEqual(snapshot);
  });
});
