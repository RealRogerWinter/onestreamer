const jwt = require('jsonwebtoken');

// Generate a token for onestreamer user
const JWT_SECRET = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';
const token = jwt.sign({ 
    userId: 1, 
    username: 'onestreamer' 
}, JWT_SECRET);

console.log('Token for onestreamer:', token);