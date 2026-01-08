import React from 'react';
import { render, screen } from '@testing-library/react';
import ViewerStats from './ViewerStats';

describe('ViewerStats', () => {
  const defaultProps = {
    viewerCount: 0,
    hasActiveStream: false,
    streamDuration: 0
  };

  test('renders viewer count correctly', () => {
    render(<ViewerStats {...defaultProps} viewerCount={5} />);
    
    expect(screen.getByText('Viewers')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  test('renders offline status when no active stream', () => {
    render(<ViewerStats {...defaultProps} />);
    
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('OFFLINE')).toBeInTheDocument();
    
    const offlineStatus = screen.getByText('OFFLINE');
    expect(offlineStatus).toHaveClass('offline');
  });

  test('renders live status when stream is active', () => {
    render(<ViewerStats {...defaultProps} hasActiveStream={true} />);
    
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    
    const liveStatus = screen.getByText('LIVE');
    expect(liveStatus).toHaveClass('live');
  });

  test('shows duration when stream is active and has duration', () => {
    const duration = 125000;
    render(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={duration} />);
    
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  test('does not show duration when stream is not active', () => {
    render(<ViewerStats {...defaultProps} streamDuration={60000} />);
    
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  });

  test('does not show duration when duration is zero', () => {
    render(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={0} />);
    
    expect(screen.queryByText('Duration')).not.toBeInTheDocument();
  });

  test('formats duration correctly for various durations', () => {
    const { rerender } = render(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={30000} />);
    expect(screen.getByText('0:30')).toBeInTheDocument();

    rerender(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={90000} />);
    expect(screen.getByText('1:30')).toBeInTheDocument();

    rerender(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={3661000} />);
    expect(screen.getByText('1:01:01')).toBeInTheDocument();
  });

  test('renders all expected stat icons', () => {
    render(<ViewerStats {...defaultProps} hasActiveStream={true} streamDuration={60000} />);
    
    expect(screen.getByText('👥')).toBeInTheDocument();
    expect(screen.getByText('⏱️')).toBeInTheDocument();
    expect(screen.getByText('📺')).toBeInTheDocument();
  });

  test('handles zero viewers correctly', () => {
    render(<ViewerStats {...defaultProps} viewerCount={0} />);
    
    expect(screen.getByText('0')).toBeInTheDocument();
  });

  test('handles large viewer count', () => {
    render(<ViewerStats {...defaultProps} viewerCount={9999} />);
    
    expect(screen.getByText('9999')).toBeInTheDocument();
  });
});