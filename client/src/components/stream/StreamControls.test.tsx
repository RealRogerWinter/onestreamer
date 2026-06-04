import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StreamControls from './StreamControls';
import PermissionService from '../../services/PermissionService';

// StreamControls gates the action button on PermissionService (added after
// these tests were written): until camera/mic are 'granted' it renders a
// "Setup Permissions" button and a click opens the permission modal instead of
// invoking the callback. The service's default export is a singleton instance,
// so spy its methods (jest.mock of a default-exported singleton is unreliable
// under the CRA transform) to exercise the take-over/start path under test.

describe('StreamControls', () => {
  const mockOnTakeOver = jest.fn();
  const mockOnStopStream = jest.fn();

  const defaultProps = {
    isStreaming: false,
    hasActiveStream: false,
    cooldownRemaining: 0,
    onTakeOver: mockOnTakeOver,
    onStopStream: mockOnStopStream
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(PermissionService, 'checkPermissions').mockResolvedValue({
      camera: 'granted', microphone: 'granted', lastChecked: 0,
    });
    jest.spyOn(PermissionService, 'canStream').mockReturnValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders start streaming button when no active stream', () => {
    render(<StreamControls {...defaultProps} />);
    
    const button = screen.getByText('Start Streaming');
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    
    expect(screen.getByText('Click "Start Streaming" to go live and be the first streamer')).toBeInTheDocument();
  });

  test('renders take over button when stream is active but user not streaming', () => {
    render(<StreamControls {...defaultProps} hasActiveStream={true} />);
    
    const button = screen.getByText('Take Over Stream');
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    
    expect(screen.getByText('Click "Take Over Stream" to disconnect the current streamer and go live')).toBeInTheDocument();
  });

  test('renders stop button when user is streaming', () => {
    render(<StreamControls {...defaultProps} isStreaming={true} />);
    
    const button = screen.getByText('Stop Streaming');
    expect(button).toBeInTheDocument();
    expect(button).toBeEnabled();
    
    expect(screen.getByText('⚠️ Others can take over your stream at any time')).toBeInTheDocument();
  });

  test('disables button and shows cooldown when cooldown is active', () => {
    render(<StreamControls {...defaultProps} cooldownRemaining={15} hasActiveStream={true} />);
    
    const button = screen.getByText('Wait 15s');
    expect(button).toBeInTheDocument();
    expect(button).toBeDisabled();
    expect(button).toHaveClass('disabled');
  });

  test('calls onTakeOver when take over button is clicked', () => {
    render(<StreamControls {...defaultProps} hasActiveStream={true} />);
    
    const button = screen.getByText('Take Over Stream');
    fireEvent.click(button);
    
    expect(mockOnTakeOver).toHaveBeenCalledTimes(1);
  });

  test('calls onStopStream when stop button is clicked', () => {
    render(<StreamControls {...defaultProps} isStreaming={true} />);
    
    const button = screen.getByText('Stop Streaming');
    fireEvent.click(button);
    
    expect(mockOnStopStream).toHaveBeenCalledTimes(1);
  });

  test('does not call onTakeOver when button is disabled due to cooldown', () => {
    render(<StreamControls {...defaultProps} cooldownRemaining={10} />);
    
    const button = screen.getByText('Wait 10s');
    fireEvent.click(button);
    
    expect(mockOnTakeOver).not.toHaveBeenCalled();
  });

  test('applies correct CSS classes to buttons', () => {
    const { rerender } = render(<StreamControls {...defaultProps} />);
    
    let button = screen.getByRole('button');
    expect(button).toHaveClass('take-over-button');
    
    rerender(<StreamControls {...defaultProps} isStreaming={true} />);
    button = screen.getByRole('button');
    expect(button).toHaveClass('stop-button');
    
    rerender(<StreamControls {...defaultProps} cooldownRemaining={5} />);
    button = screen.getByRole('button');
    expect(button).toHaveClass('disabled');
  });
});