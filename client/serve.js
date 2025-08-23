const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3443;

// Serve static files from the React app build
app.use(express.static(path.join(__dirname, 'build')));

// All other GET requests not handled will return the React app
// This ensures client-side routing works properly
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

// HTTPS configuration
const httpsOptions = {
  key: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, '..', 'certificates', 'cert.pem'))
};

const server = https.createServer(httpsOptions, app);

server.listen(PORT, () => {
  console.log(`Client server running on https://localhost:${PORT}`);
});