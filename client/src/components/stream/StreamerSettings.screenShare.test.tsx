import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StreamerSettings, { StreamerSettingsConfig } from './StreamerSettings';

// Characterization test for the Screen-share tab. Pins the rendered controls +
// the onSettingsChange wiring so the ScreenSharePanel extraction is verifiably
// behavior-preserving (tsc alone can't catch render/wiring regressions).

const baseSettings: StreamerSettingsConfig = {
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    sampleRate: 48000,
    channelCount: 2,
    profile: 'streaming',
  },
  video: {
    resolution: '720p',
    frameRate: 30,
    bitrate: 2500,
    facingMode: 'user',
    videoEnabled: true,
    mirror: false,
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

function renderSettings(overrides: Partial<React.ComponentProps<typeof StreamerSettings>> = {}) {
  const onSettingsChange = jest.fn();
  const onStartScreenShare = jest.fn();
  const onStopScreenShare = jest.fn();
  render(
    <StreamerSettings
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
      isStreaming
      isScreenSharing={false}
      onStartScreenShare={onStartScreenShare}
      onStopScreenShare={onStopScreenShare}
      {...overrides}
    />
  );
  return { onSettingsChange, onStartScreenShare, onStopScreenShare };
}

describe('StreamerSettings — Screen share tab', () => {
  beforeEach(() => {
    // setupTests mocks getUserMedia + getDisplayMedia; add the device APIs the
    // component's mount effect needs so it renders cleanly.
    (navigator.mediaDevices as any).enumerateDevices = jest.fn().mockResolvedValue([]);
    (navigator.mediaDevices as any).addEventListener = jest.fn();
    (navigator.mediaDevices as any).removeEventListener = jest.fn();
  });

  function openScreenTab() {
    fireEvent.click(screen.getByRole('button', { name: /Screen/ }));
  }

  test('renders the screen-share controls when the tab is opened', () => {
    renderSettings();
    openScreenTab();
    expect(screen.getByText('🖥️ Start Screen Share')).toBeInTheDocument();
    expect(screen.getByText('Share Type')).toBeInTheDocument();
    expect(screen.getByText('📹 Webcam Overlay')).toBeInTheDocument();
    expect(screen.getByText('🔊 System Audio')).toBeInTheDocument();
  });

  test('toggling Webcam Overlay reports pipEnabled=true via onSettingsChange', () => {
    const { onSettingsChange } = renderSettings();
    openScreenTab();
    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox in the screen panel is the pipEnabled (Webcam Overlay) toggle.
    fireEvent.click(checkboxes[0]);
    expect(onSettingsChange).toHaveBeenCalled();
    const lastArg = onSettingsChange.mock.calls[onSettingsChange.mock.calls.length - 1][0];
    expect(lastArg.screenShare.pipEnabled).toBe(true);
  });

  test('changing Share Type reports the new displaySurface', () => {
    const { onSettingsChange } = renderSettings();
    openScreenTab();
    fireEvent.change(screen.getByDisplayValue('Entire Screen'), { target: { value: 'window' } });
    const lastArg = onSettingsChange.mock.calls[onSettingsChange.mock.calls.length - 1][0];
    expect(lastArg.screenShare.displaySurface).toBe('window');
  });
});
