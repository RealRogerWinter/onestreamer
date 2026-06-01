const express = require('express');

const logger = require('../bootstrap/logger').child({ svc: 'auth' });

const router = express.Router();
const AuthService = require('../services/AuthService');
const SessionService = require('../services/SessionService');
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const requireEnv = require('../config/requireEnv');

const JWT_SECRET = requireEnv('JWT_SECRET');
const authService = new AuthService();

// Configure multer for avatar uploads
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const uploadPath = '/var/www/uploads/avatars';
        try {
            await fs.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            cb(error, null);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, `avatar-${req.user.id}-${uniqueSuffix}${ext}`);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'));
        }
    }
});

const { body } = require('express-validator');

const validateSignup = [
    body('email').isEmail().normalizeEmail(),
    body('username').isLength({ min: 3, max: 20 }).matches(/^[a-zA-Z0-9_]+$/),
    body('password').isLength({ min: 6 })
];

const validateLogin = [
    body('email').notEmpty().trim(), // Accept email or username
    body('password').notEmpty()
];

// The auth HTTP routes were decomposed into cohesive sub-route modules. The
// parent mounts them at the SAME base path ('/') so that, once this router is
// itself mounted at '/auth' in server/index.js, every path, method,
// middleware/auth order, and validation chain is identical to the prior
// monolithic router. Module-scoped state — the single AuthService instance, the
// multer `upload` config, the validation chains, and JWT_SECRET — is injected
// into each factory so a single shared instance is used process-wide
// (preserving the prior behavior). SessionService is still required here to
// match the prior module's require set (it was imported but read via
// req.app.get in handlers).
const createRegisterRouter = require('./auth/register');
const createLoginRouter = require('./auth/login');
const createEmailVerifyRouter = require('./auth/email-verify');
const createPasswordRouter = require('./auth/password');
const createSessionRouter = require('./auth/session');
const createOAuthRouter = require('./auth/oauth');
const createAccountRouter = require('./auth/account');

// Mounted in the same relative order the routes were declared in the prior
// monolithic file. The sub-routers carry non-overlapping path namespaces, so
// route-matching order is unaffected.
router.use(createRegisterRouter({ logger, authService, validateSignup }));
router.use(createLoginRouter({ logger, authService, validateLogin }));
router.use(createEmailVerifyRouter({ logger, authService }));
router.use(createPasswordRouter({ logger, authService }));
router.use(createSessionRouter({ logger, authService, upload }));
router.use(createOAuthRouter({ logger, authService, JWT_SECRET }));
router.use(createAccountRouter({ logger, authService }));

module.exports = router;
