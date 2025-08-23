#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const buildDir = path.join(__dirname, 'build');
const certPath = '/etc/letsencrypt/live/onestreamer.live/fullchain.pem';
const keyPath = '/etc/letsencrypt/live/onestreamer.live/privkey.pem';

console.log('Starting production server on port 3443...');
console.log('Serving from:', buildDir);

const serve = spawn('serve', [
  '-s', buildDir,
  '-l', '3443',
  '--ssl-cert', certPath,
  '--ssl-key', keyPath,
  '--no-clipboard'
], {
  stdio: 'inherit',
  cwd: __dirname
});

serve.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

serve.on('exit', (code) => {
  console.log('Server exited with code:', code);
  process.exit(code);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  serve.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  serve.kill('SIGINT');
});