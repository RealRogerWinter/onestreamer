const express = require('express');
const https = require('https');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3443;

// Serve static files from the build directory
app.use(express.static(path.join(__dirname, 'build')));

// Handle all routes by serving index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// SSL Configuration
const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, '../certificates/react-key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '../certificates/react-cert.pem'))
};

// Create HTTPS server
https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Production server running on https://0.0.0.0:${PORT}`);
});