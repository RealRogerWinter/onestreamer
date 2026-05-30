import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DesktopHeaderV2 from './DesktopHeaderV2';

// DesktopHeaderV2 is a pure presentational header: ALL of its data and IO arrive
// through props + callback props. It is not wired to any context, global fetch,
// localStorage, or socket-driven state of its own (the `socket` prop is merely
// forwarded to the <UserProfile/> child). So we mock the three child components
// it composes (AnimatedNumber, UserProfile, SoundVolumeControl) down to simple
// markers — UserProfile in particular pulls in AuthService/socket.io which we do
// not want to exercise here — and drive every interaction through jest.fn()
// callbacks. These tests pin CURRENT observable behavior only.

jest.mock('./AnimatedNumber', () => (props: { value: number }) => (
  <span data-testid="animated-number">{props.value}</span>
));

jest.mock('./user/UserProfile', () => (props: any) => (
  <div data-testid="user-profile">
    <button data-testid="user-profile-logout" onClick={props.onLogout}>
      logout
    </button>
  </div>
));

jest.mock('./audio/SoundVolumeControl', () => (props: any) => (
  <div data-testid="sound-volume-control">{props.volume}</div>
));

const baseProps = {
  viewerCount: 1234,
  hasActiveStream: false,
  streamDuration: 0,
  streamStartTime: null as number | null,
  streamerDisplayName: null as string | null | undefined,
  isAuthenticated: false,
  currentUser: null,
  userPoints: 0,
  isAdmin: false,
  onLogin: jest.fn(),
  onSignup: jest.fn(),
  onLogout: jest.fn(),
  onProfileSettings: jest.fn(),
  onAdminPanel: jest.fn(),
  onUserProfileUpdate: jest.fn(),
};

const renderHeader = (overrides: Partial<React.ComponentProps<typeof DesktopHeaderV2>> = {}) =>
  render(<DesktopHeaderV2 {...(baseProps as any)} {...overrides} />);

describe('DesktopHeaderV2 (characterization)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the brand logo and name', () => {
    renderHeader();
    expect(screen.getByText('OneStreamer')).toBeInTheDocument();
    expect(screen.getByAltText('OneStreamer Logo')).toBeInTheDocument();
  });

  it('shows OFFLINE status and zero-state when no active stream', () => {
    const { container } = renderHeader({ hasActiveStream: false });
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).not.toBeInTheDocument();
    // offline indicator present, no live indicator
    expect(container.querySelector('.offline-indicator')).toBeInTheDocument();
    expect(container.querySelector('.live-indicator-modern')).not.toBeInTheDocument();
  });

  it('shows LIVE status when a stream is active', () => {
    const { container } = renderHeader({ hasActiveStream: true });
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(container.querySelector('.live-indicator-modern')).toBeInTheDocument();
  });

  it('renders the viewer count, formatted with locale separators', () => {
    const { container } = renderHeader({ viewerCount: 1234 });
    expect(screen.getByText('Viewers')).toBeInTheDocument();
    const viewerEl = container.querySelector('.viewer-count');
    expect(viewerEl).toHaveTextContent('1,234');
  });

  it('renders guest auth buttons when not authenticated', () => {
    renderHeader({ isAuthenticated: false });
    expect(screen.getByText('Sign In')).toBeInTheDocument();
    expect(screen.getByText('Get Started')).toBeInTheDocument();
    expect(screen.queryByTestId('user-profile')).not.toBeInTheDocument();
  });

  it('fires onLogin and onSignup when guest buttons are clicked', () => {
    const onLogin = jest.fn();
    const onSignup = jest.fn();
    renderHeader({ isAuthenticated: false, onLogin, onSignup });
    fireEvent.click(screen.getByText('Sign In'));
    expect(onLogin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Get Started'));
    expect(onSignup).toHaveBeenCalledTimes(1);
  });

  it('renders points display and user profile when authenticated', () => {
    renderHeader({ isAuthenticated: true, userPoints: 4200 });
    expect(screen.getByTestId('user-profile')).toBeInTheDocument();
    expect(screen.getByText('Points')).toBeInTheDocument();
    expect(screen.getByTestId('animated-number')).toHaveTextContent('4200');
    // guest buttons gone
    expect(screen.queryByText('Sign In')).not.toBeInTheDocument();
    expect(screen.queryByText('Get Started')).not.toBeInTheDocument();
  });

  it('forwards onLogout from the user profile child', () => {
    const onLogout = jest.fn();
    renderHeader({ isAuthenticated: true, onLogout });
    fireEvent.click(screen.getByTestId('user-profile-logout'));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('shows the admin/moderator button only for admins/mods and fires onAdminPanel', () => {
    const onAdminPanel = jest.fn();
    const { container, rerender } = renderHeader({ isAuthenticated: true, isAdmin: false, isModerator: false });
    expect(container.querySelector('.admin-btn-modern')).not.toBeInTheDocument();

    rerender(<DesktopHeaderV2 {...(baseProps as any)} isAuthenticated isAdmin onAdminPanel={onAdminPanel} />);
    const adminBtn = container.querySelector('.admin-btn-modern') as HTMLElement;
    expect(adminBtn).toBeInTheDocument();
    expect(adminBtn).toHaveAttribute('title', expect.stringContaining('Admin'));
    fireEvent.click(adminBtn);
    expect(onAdminPanel).toHaveBeenCalledTimes(1);
  });

  it('labels the admin button as Moderator when moderator but not admin', () => {
    const { container } = renderHeader({ isAuthenticated: true, isAdmin: false, isModerator: true });
    const adminBtn = container.querySelector('.admin-btn-modern') as HTMLElement;
    expect(adminBtn).toBeInTheDocument();
    expect(adminBtn).toHaveAttribute('title', expect.stringContaining('Moderator'));
  });

  it('renders the current streamer card with displayName when live', () => {
    const { container } = renderHeader({
      hasActiveStream: true,
      streamerDisplayName: 'CoolStreamer',
    });
    expect(screen.getByText('Streaming')).toBeInTheDocument();
    const streamerCard = container.querySelector('.streamer-card');
    expect(streamerCard).toBeInTheDocument();
    expect(within(streamerCard as HTMLElement).getByText('CoolStreamer')).toBeInTheDocument();
  });

  it('renders the streamer as an external link during random rotation', () => {
    renderHeader({
      hasActiveStream: true,
      streamerDisplayName: 'RelayDisplay',
      isRandomRotation: true,
      randomRotationPlatform: 'twitch',
      randomRotationStreamerUrl: 'https://twitch.tv/somebody',
      randomRotationStreamerUsername: 'somebody',
    });
    const link = screen.getByRole('link', { name: /somebody/i });
    expect(link).toHaveAttribute('href', 'https://twitch.tv/somebody');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders the duration card only when a stream has a start time', () => {
    const { container, rerender } = renderHeader({ hasActiveStream: true, streamStartTime: null });
    expect(container.querySelector('.duration-card')).not.toBeInTheDocument();

    rerender(
      <DesktopHeaderV2
        {...(baseProps as any)}
        hasActiveStream
        streamStartTime={Date.now()}
        streamerDisplayName="X"
      />
    );
    expect(container.querySelector('.duration-card')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
  });

  it('renders theatre-mode action links (clips/blog/discord) when in theatre mode', () => {
    const { container } = renderHeader({ isTheatreMode: true });
    expect(container.querySelector('.theatre-clips-btn')).toBeInTheDocument();
    expect(container.querySelector('.theatre-blog-btn')).toBeInTheDocument();
    expect(container.querySelector('.theatre-discord-btn')).toBeInTheDocument();
    // inventory button present
    expect(container.querySelector('.theatre-inventory-btn')).toBeInTheDocument();
  });

  it('does not render theatre-mode buttons when not in theatre mode', () => {
    const { container } = renderHeader({ isTheatreMode: false });
    expect(container.querySelector('.theatre-clips-btn')).not.toBeInTheDocument();
    expect(container.querySelector('.theatre-dropdown-container')).not.toBeInTheDocument();
  });

  it('fires onInventoryToggle when the inventory button is clicked (theatre mode)', () => {
    const onInventoryToggle = jest.fn();
    const { container } = renderHeader({ isTheatreMode: true, onInventoryToggle });
    fireEvent.click(container.querySelector('.theatre-inventory-btn') as HTMLElement);
    expect(onInventoryToggle).toHaveBeenCalledTimes(1);
  });

  it('renders the SoundVolumeControl only when onSoundVolumeChange is provided in theatre mode', () => {
    const { rerender } = renderHeader({ isTheatreMode: true });
    expect(screen.queryByTestId('sound-volume-control')).not.toBeInTheDocument();

    rerender(
      <DesktopHeaderV2 {...(baseProps as any)} isTheatreMode onSoundVolumeChange={jest.fn()} soundVolume={0.5} />
    );
    expect(screen.getByTestId('sound-volume-control')).toHaveTextContent('0.5');
  });

  it('toggles the theatre dropdown via onTheatreDropdownToggle and renders items when open', () => {
    const onTheatreDropdownToggle = jest.fn();
    const { container } = renderHeader({
      isTheatreMode: true,
      theatreDropdownOpen: false,
      onTheatreDropdownToggle,
    });
    const dropdownBtn = container.querySelector('.theatre-dropdown-btn') as HTMLElement;
    expect(dropdownBtn).toBeInTheDocument();
    expect(container.querySelector('.theatre-dropdown-menu')).not.toBeInTheDocument();
    fireEvent.click(dropdownBtn);
    expect(onTheatreDropdownToggle).toHaveBeenCalledTimes(1);
  });

  it('fires the matching callback and closes the dropdown for dropdown items when open', () => {
    const onShowTutorial = jest.fn();
    const onShowAbout = jest.fn();
    const onTheatreDropdownToggle = jest.fn();
    renderHeader({
      isTheatreMode: true,
      theatreDropdownOpen: true,
      onShowTutorial,
      onShowAbout,
      onTheatreDropdownToggle,
    });
    fireEvent.click(screen.getByText('Tutorial'));
    expect(onShowTutorial).toHaveBeenCalledTimes(1);
    expect(onTheatreDropdownToggle).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('About'));
    expect(onShowAbout).toHaveBeenCalledTimes(1);
    expect(onTheatreDropdownToggle).toHaveBeenCalledTimes(2);
  });

  it('renders the live clock time card', () => {
    const { container } = renderHeader();
    expect(container.querySelector('.time-display')).toBeInTheDocument();
  });
});
