import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import StreamControls from './StreamControls';

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