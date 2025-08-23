const io = require('socket.io-client');
const socket = io('http://localhost:8080');

socket.on('connect', () => {
  console.log('Connected, emitting stream-ready...');
  
  // Get current info from simple rotation
  const http = require('http');
  const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/admin/simple-rotation/status',
    headers: { 'x-admin-key': '***REMOVED-ADMIN-KEY***' }
  };
  
  http.get(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const status = JSON.parse(data);
      if (status.currentBot && status.hasProducers) {
        // Emit stream-ready as server would
        socket.emit('server-emit', {
          event: 'stream-ready',
          data: {
            streamerId: status.currentBot,
            producerId: 'test',
            streamType: 'viewbot',
            isViewBot: true
          }
        });
        console.log('Emitted stream-ready for', status.currentBot);
      }
      setTimeout(() => process.exit(0), 1000);
    });
  }).on('error', console.error);
});

socket.on('error', console.error);
