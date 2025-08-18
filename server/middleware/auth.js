const jwt = require('jsonwebtoken');
const AuthService = require('../services/AuthService');
const AccountService = require('../services/AccountService');

const authService = new AuthService();

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = authService.verifyToken(token);
    
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = decoded;
    next();
};

const authenticateAdmin = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    console.log('🔐 Admin auth check - Token present:', !!token);

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = authService.verifyToken(token);
    
    console.log('🔐 Admin auth - Token decoded:', !!decoded, decoded?.id);
    
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
        // Check if user exists and is admin
        const accountService = new AccountService();
        const userRecord = await accountService.getUserById(decoded.id);
        
        console.log('🔐 Admin auth - User found:', !!userRecord, 'Is admin:', userRecord?.is_admin);
        
        if (!userRecord) {
            return res.status(403).json({ error: 'User not found' });
        }
        
        if (!userRecord.is_admin) {
            console.log('🔐 Admin auth - User is not admin:', userRecord.username);
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (userRecord.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        
        console.log('🔐 Admin auth - Access granted for:', userRecord.username);
        req.user = decoded;
        req.userRecord = userRecord;
        next();
    } catch (err) {
        console.error('Admin authentication error:', err);
        return res.status(500).json({ error: 'Authentication failed' });
    }
};

const optionalAuth = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
        const decoded = authService.verifyToken(token);
        if (decoded) {
            req.user = decoded;
        }
    }

    next();
};

module.exports = {
    authenticateToken,
    authenticateAdmin,
    optionalAuth
};