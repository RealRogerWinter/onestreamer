import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StreamerSettings, { StreamerSettingsConfig } from './StreamerSettings';

// Characterization test for StreamerSettings. Pins the CURRENT observable
// behavior (rendered controls across the Audio/Video tabs, the onSettingsChange
// wiring fired by presets / toggles / select changes, device enumeration,
// compact-mode collapse) so the upcoming hook + section extraction is
// verifiably behavior-preserving. This is ADDITIONAL to the existing
// StreamerSettings.screenShare.test.tsx — both must stay green.
//
// IO layer pinned here (verified against the real component):
//   - onSettingsChange / onStartScreenShare / onStopScreenShare callback props
//     (mocked via jest.fn())
//   - navigator.mediaDevices.getUserMedia / enumerateDevices / add+removeEventListener
//     (getUserMedia/getDisplayMedia come from setupTests; the rest added here)
//   - CookieService.setCookie (side-effect of handleSettingsChange) — left real;
//     it writes to document.cookie which is harmless under jsdom.

const baseSettings: StreamerSettingsConfig = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    sampleRate: 48000,
    channelCount: 2,
    profile: 'streaming',
    inputDeviceId: 'mic-1',
    outputDeviceId: 'spk-1',
  },
  video: {
    resolution: '720p',
    frameRate: 30,
    bitrate: 1500000,
    facingMode: 'user',
    videoEnabled: true,
    mirror: false,
    videoDeviceId: 'cam-1',
  },
  screenShare: {
    cursor: 'always',
    audio: false,
    mixWithMic: true,
    micGain: 100,
    systemGain: 100,
    displaySurface: 'monitor',
    pipEnabled: false,
    pipPosition: 'bottom-right',
    pipSize: 25,
  },
};

function renderSettings(
  overrides: Partial<React.ComponentProps<typeof StreamerSettings>> = {}
) {
  const onSettingsChange = jest.fn();
  const onStartScreenShare = jest.fn();
  const onStopScreenShare = jest.fn();
  const result = render(
    <StreamerSettings
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
      isStreaming={false}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      {...overrides}
    />
  );
  return { onSettingsChange, onStartScreenShare, onStopScreenShare, ...result };
}

function lastChange(fn: jest.Mock): StreamerSettingsConfig {
  return fn.mock.calls[fn.mock.calls.length - 1][0];
}

describe('StreamerSettings — characterization', () => {
  beforeEach(() => {
    // setupTests mocks getUserMedia + getDisplayMedia; the mount effect also
    // calls enumerateDevices + add/removeEventListener, so stub those.
    (navigator.mediaDevices as any).enumerateDevices = jest
      .fn()
      .mockResolvedValue([]);
    (navigator.mediaDevices as any).addEventListener = jest.fn();
    (navigator.mediaDevices as any).removeEventListener = jest.fn();
  });

  test('renders the header and the Audio tab active by default', () => {
    renderSettings();
    expect(
      screen.getByRole('heading', { name: /Streamer Settings/ })
    ).toBeInTheDocument();
    // Audio tab is the default active tab.
    const audioTab = screen.getByRole('button', { name: /🎵 Audio/ });
    expect(audioTab.className).toContain('active');
    // Audio panel content is present.
    expect(screen.getByText('Quick Audio Presets:')).toBeInTheDocument();
    expect(screen.getByText('Echo Cancellation')).toBeInTheDocument();
  });

  test('renders Audio, Video and Screen tab buttons', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: /🎵 Audio/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /📹 Video/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /🖥️ Screen/ })).toBeInTheDocument();
  });

  test('the audio profile preset reflected as active matches settings.audio.profile', () => {
    renderSettings();
    const streamingBtn = screen.getByRole('button', { name: 'Streaming' });
    expect(streamingBtn.className).toContain('active');
    const rawBtn = screen.getByRole('button', { name: 'Raw Audio' });
    expect(rawBtn.className).not.toContain('active');
  });

  test('clicking an audio preset reports the new profile via onSettingsChange', () => {
    const { onSettingsChange } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: 'Music' }));
    expect(onSettingsChange).toHaveBeenCalled();
    const arg = lastChange(onSettingsChange);
    expect(arg.audio.profile).toBe('music');
    expect(arg.audio.echoCancellation).toBe(false);
    expect(arg.audio.sampleRate).toBe(48000);
  });

  test('toggling Echo Cancellation flips the boolean via onSettingsChange', () => {
    const { onSettingsChange } = renderSettings();
    const echoCheckbox = screen
      .getByText('Echo Cancellation')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(echoCheckbox.checked).toBe(true);
    fireEvent.click(echoCheckbox);
    const arg = lastChange(onSettingsChange);
    expect(arg.audio.echoCancellation).toBe(false);
  });

  test('changing Sample Rate select reports a numeric value', () => {
    const { onSettingsChange } = renderSettings();
    const sampleSelect = screen
      .getByText('Sample Rate')
      .closest('label')!
      .querySelector('select') as HTMLSelectElement;
    fireEvent.change(sampleSelect, { target: { value: '44100' } });
    const arg = lastChange(onSettingsChange);
    expect(arg.audio.sampleRate).toBe(44100);
    expect(typeof arg.audio.sampleRate).toBe('number');
  });

  test('switching to the Video tab renders video controls', () => {
    renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Video/ }));
    expect(screen.getByText('Quick Video Presets:')).toBeInTheDocument();
    expect(screen.getByText('Enable Video')).toBeInTheDocument();
    expect(screen.getByText('Mirror Video')).toBeInTheDocument();
    expect(screen.getByText('Resolution')).toBeInTheDocument();
  });

  test('clicking the Max video preset reports 720p/30fps via onSettingsChange', () => {
    const { onSettingsChange } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Video/ }));
    fireEvent.click(screen.getByRole('button', { name: /Max \(720p\)/ }));
    const arg = lastChange(onSettingsChange);
    expect(arg.video.resolution).toBe('720p');
    expect(arg.video.frameRate).toBe(30);
    expect(arg.video.bitrate).toBe(1500000);
  });

  test('toggling Mirror Video on the Video tab flips the boolean', () => {
    const { onSettingsChange } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Video/ }));
    const mirrorCheckbox = screen
      .getByText('Mirror Video')
      .closest('label')!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(mirrorCheckbox);
    const arg = lastChange(onSettingsChange);
    expect(arg.video.mirror).toBe(true);
  });

  test('changing Resolution select reports the new resolution', () => {
    const { onSettingsChange } = renderSettings();
    fireEvent.click(screen.getByRole('button', { name: /Video/ }));
    const resSelect = screen
      .getByText('Resolution')
      .closest('label')!
      .querySelector('select') as HTMLSelectElement;
    fireEvent.change(resSelect, { target: { value: '480p' } });
    const arg = lastChange(onSettingsChange);
    expect(arg.video.resolution).toBe('480p');
  });

  test('the info footer reflects current audio profile and video resolution', () => {
    renderSettings();
    expect(screen.getByText('streaming')).toBeInTheDocument();
    expect(screen.getByText(/720p @ 30fps/)).toBeInTheDocument();
  });

  test('starting a microphone test toggles the test button label', async () => {
    renderSettings();
    const testBtn = screen.getByRole('button', { name: /Test Microphone/ });
    fireEvent.click(testBtn);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Stop Test/ })).toBeInTheDocument()
    );
  });

  test('compact mode collapsed shows only the expand button', () => {
    renderSettings({ compact: true });
    expect(
      screen.getByRole('button', { name: /Streamer Settings/ })
    ).toBeInTheDocument();
    // The full panel header (h3) is not rendered while collapsed.
    expect(
      screen.queryByRole('heading', { name: /Streamer Settings/ })
    ).not.toBeInTheDocument();
  });

  test('expanding compact mode reveals the full settings panel', () => {
    renderSettings({ compact: true });
    fireEvent.click(screen.getByRole('button', { name: /Streamer Settings/ }));
    expect(
      screen.getByRole('heading', { name: /Streamer Settings/ })
    ).toBeInTheDocument();
  });

  test('the Screen tab opens and shows the start screen-share button', () => {
    renderSettings({ isStreaming: true });
    fireEvent.click(screen.getByRole('button', { name: /Screen/ }));
    expect(screen.getByText('🖥️ Start Screen Share')).toBeInTheDocument();
  });

  test('isStreaming shows the live-changes warning banner', () => {
    renderSettings({ isStreaming: true });
    expect(
      screen.getByText(/Live - Changes apply instantly/)
    ).toBeInTheDocument();
  });
});
