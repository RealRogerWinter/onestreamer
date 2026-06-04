import React from 'react';
import { render, screen } from '@testing-library/react';
import StreamViewer from './StreamViewer';

// StreamViewer renders the heavy LiveKit WebRTC children (WebRTCViewer /
// WebRTCStreamer), which initialise real WebRTC/LiveKit APIs and throw under
// jsdom. These tests cover StreamViewer's own view-state markup, so stub the
// children out.
jest.mock('./WebRTCViewer', () => ({ __esModule: true, default: () => null }));
jest.mock('./WebRTCStreamer', () => ({ __esModule: true, default: () => null }));

const mockSocket = {
  emit: jest.fn(),
  on: jest.fn(),
  disconnect: jest.fn(),
  connected: true,
  id: 'mock-socket-id'
} as any;

describe('StreamViewer', () => {
  const defaultProps = {
    socket: mockSocket,
    isStreaming: false,
    hasActiveStream: false
  };

  test('renders no stream message when no active stream', () => {
    render(<StreamViewer {...defaultProps} />);
    
    expect(screen.getByText('No Active Stream')).toBeInTheDocument();
    expect(screen.getByText('Be the first to start streaming!')).toBeInTheDocument();
  });

  test('renders streaming view when user is streaming', () => {
    render(<StreamViewer {...defaultProps} isStreaming={true} />);
    
    expect(screen.getByText('You are streaming')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  test('renders viewing mode when viewing active stream', () => {
    render(<StreamViewer {...defaultProps} hasActiveStream={true} />);
    
    expect(screen.getByText('LIVE')).toBeInTheDocument();
  });

  test('applies correct CSS classes based on state', () => {
    const { rerender } = render(<StreamViewer {...defaultProps} />);
    expect(document.querySelector('.no-stream')).toBeInTheDocument();

    rerender(<StreamViewer {...defaultProps} isStreaming={true} />);
    expect(document.querySelector('.streaming-view')).toBeInTheDocument();

    rerender(<StreamViewer {...defaultProps} hasActiveStream={true} />);
    expect(document.querySelector('.viewing-mode')).toBeInTheDocument();
  });
});