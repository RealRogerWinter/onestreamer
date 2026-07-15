const jwt = require('jsonwebtoken');
const AuthService = require('../services/AuthService');
const AccountService = require('../services/AccountService');

const logger = require('../bootstrap/logger').child({ svc: 'auth' });
const authService = new AuthService();

const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = authService.verifyToken(token);
    
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    // Check if account is deleted or pending deletion
    try {
        const accountService = new AccountService();
        const userRecord = await accountService.getUserById(decoded.userId || decoded.id);
        
        if (!userRecord) {
            return res.status(403).json({ error: 'User not found' });
        }
        
        if (userRecord.account_status === 'deleted') {
            return res.status(403).json({ error: 'Account has been deleted' });
        }
        
        if (userRecord.account_status === 'pending_deletion') {
            // Allow access but include warning
            res.setHeader('X-Account-Status', 'pending_deletion');
        }
        
        if (userRecord.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
    } catch (err) {
        // S9: fail CLOSED. A DB error in the status/ban check used to be
        // swallowed and the request proceeded — the same posture the admin
        // and moderator variants already reject on. A banned/deleted user
        // must not slip through on a transient DB error.
        logger.error({ err }, 'Authentication check error - failing closed');
        return res.status(500).json({ error: 'Authentication check failed' });
    }

    req.user = decoded;
    next();
};

const authenticateAdmin = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    logger.debug('🔐 Admin auth check - Token present:', !!token);

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = authService.verifyToken(token);
    
    logger.debug('🔐 Admin auth - Token decoded:', !!decoded, decoded?.userId || decoded?.id);
    
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
        // Check if user exists and is admin
        const accountService = new AccountService();
        const userRecord = await accountService.getUserById(decoded.userId || decoded.id);
        
        logger.debug('🔐 Admin auth - User found:', !!userRecord, 'Is admin:', userRecord?.is_admin);
        
        if (!userRecord) {
            return res.status(403).json({ error: 'User not found' });
        }
        
        if (!userRecord.is_admin) {
            logger.debug('🔐 Admin auth - User is not admin:', userRecord.username);
            return res.status(403).json({ error: 'Admin access required' });
        }

        if (userRecord.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        
        logger.debug('🔐 Admin auth - Access granted for:', userRecord.username);
        req.user = decoded;
        req.userRecord = userRecord;
        next();
    } catch (err) {
        logger.error('Admin authentication error:', err);
        return res.status(500).json({ error: 'Authentication failed' });
    }
};

const authenticateModerator = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    logger.debug('🔐 Moderator auth check - Token present:', !!token);

    if (!token) {
        return res.status(401).json({ error: 'Access token required' });
    }

    const decoded = authService.verifyToken(token);
    
    logger.debug('🔐 Moderator auth - Token decoded:', !!decoded, decoded?.id);
    
    if (!decoded) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }

    try {
        // Check if user exists and is moderator or admin
        const accountService = new AccountService();
        const userRecord = await accountService.getUserById(decoded.id);
        
        logger.debug('🔐 Moderator auth - User found:', !!userRecord, 'Is moderator:', userRecord?.is_moderator, 'Is admin:', userRecord?.is_admin);
        
        if (!userRecord) {
            return res.status(403).json({ error: 'User not found' });
        }
        
        if (!userRecord.is_moderator && !userRecord.is_admin) {
            logger.debug('🔐 Moderator auth - User is not moderator or admin:', userRecord.username);
            return res.status(403).json({ error: 'Moderator access required' });
        }

        if (userRecord.is_banned) {
            return res.status(403).json({ error: 'Account is banned' });
        }
        
        logger.debug('🔐 Moderator auth - Access granted for:', userRecord.username);
        req.user = decoded;
        req.userRecord = userRecord;
        next();
    } catch (err) {
        logger.error('Moderator authentication error:', err);
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
    authenticateModerator,
    optionalAuth
};
