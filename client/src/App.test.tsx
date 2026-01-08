import React from 'react';
import { render } from '@testing-library/react';
import App from './App';

// Simple smoke test - just ensure the app renders without crashing
test('renders without crashing', () => {
  // Mock the necessary globals
  global.navigator = {
    ...global.navigator,
    mediaDevices: {
      getUserMedia: jest.fn().mockResolvedValue({
        getTracks: () => []
      })
    } as any
  };

  global.RTCPeerConnection = jest.fn() as any;

  // Mock socket.io-client
  jest.doMock('socket.io-client', () => jest.fn(() => ({
    emit: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
    id: 'mock-socket-id'
  })));

  // Simple render test
  expect(() => render(<App />)).not.toThrow();
});
