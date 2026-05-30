import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import ProfileSettings from './ProfileSettings';
import authService from '../../services/AuthService';
import CookieConsentService from '../../services/CookieConsentService';

// ProfileSettings loads and mutates all of its data through `authService`
// instance methods (getProfile / updateProfile / changeUsername / uploadAvatar
// / deleteAvatar / resendVerificationEmail / requestAccountDeletion). It also
// calls CookieConsentService.showPreferences() and uses window.confirm for the
// avatar-delete flow. There is no raw fetch and no socket. The only props are
// isOpen, onClose and onProfileUpdate. These characterization tests pin the
// CURRENT observable behavior: render+load, editing fields, save payloads,
// section content, validation messages, and the destructive delete flow.

jest.mock('../../services/AuthService', () => ({
  __esModule: true,
  default: {
    getProfile: jest.fn(),
    updateProfile: jest.fn(),
    changeUsername: jest.fn(),
    uploadAvatar: jest.fn(),
    deleteAvatar: jest.fn(),
    resendVerificationEmail: jest.fn(),
    requestAccountDeletion: jest.fn(),
    getToken: jest.fn(() => 'test-token'),
  },
}));

jest.mock('../../services/CookieConsentService', () => ({
  __esModule: true,
  default: {
    showPreferences: jest.fn(),
  },
}));

const mockedAuth = authService as jest.Mocked<typeof authService>;
const mockedCookies = CookieConsentService as jest.Mocked<typeof CookieConsentService>;

// --- Fixtures -------------------------------------------------------------

const baseProfile = {
  user: {
    username: 'alice',
    email: 'alice@example.com',
    is_verified: true,
    canChangeUsername: false,
    avatar_url: undefined as string | undefined,
    description: 'hello world',
  },
  stats: {
    points: 42,
    total_stream_time: 3661, // 1h 1m
    total_view_time: 120, // 0h 2m
    stream_count: 5,
    chat_message_count: 99,
  },
};

function makeProfile(overrides: any = {}) {
  return {
    user: { ...baseProfile.user, ...(overrides.user || {}) },
    stats: { ...baseProfile.stats, ...(overrides.stats || {}) },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Re-prime token + default profile after CRA's between-test mock reset.
  (mockedAuth.getToken as jest.Mock).mockReturnValue('test-token');
  (mockedAuth.getProfile as jest.Mock).mockResolvedValue(makeProfile());
  (mockedAuth.updateProfile as jest.Mock).mockResolvedValue({ success: true });
  (mockedAuth.changeUsername as jest.Mock).mockResolvedValue({ success: true });
  (mockedAuth.uploadAvatar as jest.Mock).mockResolvedValue({ success: true, avatar_url: 'http://x/a.png' });
  (mockedAuth.deleteAvatar as jest.Mock).mockResolvedValue({ success: true });
  (mockedAuth.resendVerificationEmail as jest.Mock).mockResolvedValue({ success: true, message: 'sent!' });
  (mockedAuth.requestAccountDeletion as jest.Mock).mockResolvedValue({ success: true });
});

function renderOpen(props: Partial<React.ComponentProps<typeof ProfileSettings>> = {}) {
  const onClose = jest.fn();
  const onProfileUpdate = jest.fn();
  const utils = render(
    <ProfileSettings isOpen onClose={onClose} onProfileUpdate={onProfileUpdate} {...props} />
  );
  return { onClose, onProfileUpdate, ...utils };
}

// --- Tests ----------------------------------------------------------------

describe('ProfileSettings characterization', () => {
  test('renders nothing when isOpen is false', () => {
    const { container } = render(
      <ProfileSettings isOpen={false} onClose={jest.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(mockedAuth.getProfile).not.toHaveBeenCalled();
  });

  test('loads the profile on open and renders username, email and stats', async () => {
    renderOpen();
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(mockedAuth.getProfile).toHaveBeenCalledTimes(1);
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    // Stats section
    expect(screen.getByText('Account Statistics')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('1h 1m')).toBeInTheDocument(); // formatTime(3661)
    expect(screen.getByText('0h 2m')).toBeInTheDocument(); // formatTime(120)
  });

  test('renders the major sections', async () => {
    renderOpen();
    await screen.findByText('alice');
    expect(screen.getByText('Profile Settings')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByText('Account Information')).toBeInTheDocument();
    expect(screen.getByText('Privacy Settings')).toBeInTheDocument();
    expect(screen.getByText('Danger Zone')).toBeInTheDocument();
  });

  test('shows a verification warning + resend button when email is not verified', async () => {
    (mockedAuth.getProfile as jest.Mock).mockResolvedValue(
      makeProfile({ user: { is_verified: false } })
    );
    renderOpen();
    await screen.findByText('alice');
    expect(screen.getByText(/Not verified/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resend Verification' }));
    await waitFor(() => expect(mockedAuth.resendVerificationEmail).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('sent!')).toBeInTheDocument();
  });

  test('Edit Profile reveals the email input and password fields', async () => {
    renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter current password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter new password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Confirm new password')).toBeInTheDocument();
  });

  test('saving an edited email calls updateProfile with the new email', async () => {
    const { onProfileUpdate } = renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));

    const emailInput = screen.getByDisplayValue('alice@example.com');
    fireEvent.change(emailInput, { target: { name: 'email', value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() =>
      expect(mockedAuth.updateProfile).toHaveBeenCalledWith({ email: 'new@example.com' })
    );
    expect(await screen.findByText('Profile updated successfully')).toBeInTheDocument();
    expect(onProfileUpdate).toHaveBeenCalled();
  });

  test('password change validation: mismatched passwords show an error and do NOT call updateProfile', async () => {
    renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));

    fireEvent.change(screen.getByPlaceholderText('Enter new password'), {
      target: { name: 'newPassword', value: 'abc12345' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), {
      target: { name: 'confirmPassword', value: 'different' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(await screen.findByText('New passwords do not match')).toBeInTheDocument();
    expect(mockedAuth.updateProfile).not.toHaveBeenCalled();
  });

  test('password change validation: missing current password shows an error', async () => {
    renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Profile' }));

    fireEvent.change(screen.getByPlaceholderText('Enter new password'), {
      target: { name: 'newPassword', value: 'abc12345' },
    });
    fireEvent.change(screen.getByPlaceholderText('Confirm new password'), {
      target: { name: 'confirmPassword', value: 'abc12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

    expect(
      await screen.findByText('Current password is required to change password')
    ).toBeInTheDocument();
    expect(mockedAuth.updateProfile).not.toHaveBeenCalled();
  });

  test('editing the description reveals a Save Description button that calls updateProfile', async () => {
    const { onProfileUpdate } = renderOpen();
    await screen.findByText('alice');

    const textarea = screen.getByPlaceholderText('Tell others about yourself...');
    fireEvent.change(textarea, { target: { value: 'a brand new bio' } });

    const saveBtn = await screen.findByRole('button', { name: 'Save Description' });
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(mockedAuth.updateProfile).toHaveBeenCalledWith({ description: 'a brand new bio' })
    );
    expect(await screen.findByText('Description updated successfully')).toBeInTheDocument();
    expect(onProfileUpdate).toHaveBeenCalled();
  });

  test('character count reflects the description length', async () => {
    renderOpen();
    await screen.findByText('alice');
    // initial description "hello world" => 11 chars
    expect(screen.getByText('11/500 characters')).toBeInTheDocument();
  });

  test('one-time username change: editing + saving calls changeUsername', async () => {
    (mockedAuth.getProfile as jest.Mock).mockResolvedValue(
      makeProfile({ user: { canChangeUsername: true } })
    );
    renderOpen();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Change (One-time)' }));
    const input = screen.getByPlaceholderText('Enter new username');
    fireEvent.change(input, { target: { value: 'alice2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockedAuth.changeUsername).toHaveBeenCalledWith('alice2'));
  });

  test('username validation: too-short username shows an error and does NOT call changeUsername', async () => {
    (mockedAuth.getProfile as jest.Mock).mockResolvedValue(
      makeProfile({ user: { canChangeUsername: true } })
    );
    renderOpen();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Change (One-time)' }));
    fireEvent.change(screen.getByPlaceholderText('Enter new username'), {
      target: { value: 'ab' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Username must be between 3 and 20 characters')
    ).toBeInTheDocument();
    expect(mockedAuth.changeUsername).not.toHaveBeenCalled();
  });

  test('Manage Cookies button calls CookieConsentService.showPreferences', async () => {
    renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: 'Manage Cookies' }));
    expect(mockedCookies.showPreferences).toHaveBeenCalledTimes(1);
  });

  test('delete flow (verified): opens modal, requires exact phrase, then calls requestAccountDeletion', async () => {
    renderOpen();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));

    // Modal opens with the confirmation input
    const confirmInput = await screen.findByPlaceholderText('Type here to confirm');
    const requestBtn = screen.getByRole('button', { name: 'Request Deletion' });
    // Disabled until exact phrase typed
    expect(requestBtn).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: 'DELETE MY ACCOUNT' } });
    expect(requestBtn).not.toBeDisabled();

    fireEvent.click(requestBtn);
    await waitFor(() => expect(mockedAuth.requestAccountDeletion).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/confirmation email has been sent/i)
    ).toBeInTheDocument();
  });

  test('delete flow (unverified): modal shows the verification-required message instead of the form', async () => {
    (mockedAuth.getProfile as jest.Mock).mockResolvedValue(
      makeProfile({ user: { is_verified: false } })
    );
    renderOpen();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Account' }));
    expect(
      await screen.findByText(/email address must be verified/i)
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Type here to confirm')).not.toBeInTheDocument();
  });

  test('avatar delete asks for window.confirm and calls deleteAvatar when confirmed', async () => {
    (mockedAuth.getProfile as jest.Mock).mockResolvedValue(
      makeProfile({ user: { avatar_url: 'http://x/old.png' } })
    );
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderOpen();
    await screen.findByText('alice');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => expect(mockedAuth.deleteAvatar).toHaveBeenCalledTimes(1));
    confirmSpy.mockRestore();
  });

  test('clicking the overlay invokes onClose', async () => {
    const { onClose, container } = renderOpen();
    await screen.findByText('alice');
    const overlay = container.querySelector('.profile-settings-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalled();
  });

  test('close button invokes onClose', async () => {
    const { onClose } = renderOpen();
    await screen.findByText('alice');
    fireEvent.click(screen.getByRole('button', { name: '×' }));
    expect(onClose).toHaveBeenCalled();
  });
});
