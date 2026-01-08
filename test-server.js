const http = require('http');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Test server working\!\n');
});

server.listen(8080, '0.0.0.0', () => {
  console.log('Test server listening on port 8080');
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

// Keep alive
setInterval(() => {
  console.log('Server still running...');
}, 2000);
EOF < /dev/null
