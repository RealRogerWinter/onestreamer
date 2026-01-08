#!/usr/bin/env node

/**
 * Test JWT token validation to see why chat messages aren't being tracked
 */

const jwt = require('jsonwebtoken');

// JWT secret (should match both servers)
const JWT_SECRET = process.env.JWT_SECRET || '***REMOVED-JWT-DEFAULT***';

// Test token validation function (copied from chat service)
function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    console.log('✅ Token validation successful:', {
      id: decoded.id,
      username: decoded.username,
      email: decoded.email
    });
    return decoded;
  } catch (error) {
    console.error('❌ Token validation failed:', error.message);
    return null;
  }
}

console.log('🧪 JWT Token Validation Test');
console.log('📋 Using JWT_SECRET:', JWT_SECRET);

// You'll need to get this token from your browser's localStorage
// Open browser dev tools -> Application/Storage -> Local Storage -> onestreamer-auth-token
console.log('\n📝 To test your token:');
console.log('1. Open browser dev tools');
console.log('2. Go to Application/Storage tab -> Local Storage');
console.log('3. Find "onestreamer-auth-token" and copy its value');
console.log('4. Paste the token as an argument to this script');
console.log('\nExample: node test-jwt-token.js "your-token-here"');

const testToken = process.argv[2];

if (testToken) {
  console.log('\n🔍 Testing provided token...');
  const result = verifyToken(testToken);
  
  if (result) {
    console.log('\n✅ Token is valid! Chat messages should be tracked for this user.');
  } else {
    console.log('\n❌ Token is invalid! This explains why chat messages are not being tracked.');
  }
} else {
  console.log('\n⚠️  No token provided for testing.');
}