const express = require('express');
const fs = require('fs');
const path = require('path');

const logger = require('../bootstrap/logger').child({ svc: 'tutorial' });

const router = express.Router();

const AuthService = require('../services/AuthService');
const AccountService = require('../services/AccountService');

const authService = new AuthService();
const accountService = new AccountService();

const DATA_DIR = path.join(__dirname, '..', 'data');
const TUTORIAL_TXT_PATH = path.join(DATA_DIR, 'tutorial.txt');
const TUTORIAL_TABS_PATH = path.join(DATA_DIR, 'tutorial-tabs.json');

router.get('/', (req, res) => {
  try {
    if (fs.existsSync(TUTORIAL_TABS_PATH)) {
      const tabs = JSON.parse(fs.readFileSync(TUTORIAL_TABS_PATH, 'utf8'));
      return res.json({ tabs });
    }
    if (fs.existsSync(TUTORIAL_TXT_PATH)) {
      const content = fs.readFileSync(TUTORIAL_TXT_PATH, 'utf8');
      return res.json({ content });
    }
    return res.json({ content: '' });
  } catch (error) {
    logger.error('Failed to load tutorial:', error);
    return res.status(500).json({ error: 'Failed to load tutorial content' });
  }
});

router.post('/', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const decoded = authService.verifyToken(token);
    if (!decoded) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    const user = await accountService.getUserById(decoded.id);
    if (!user || !user.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    const { content, tabs } = req.body;

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (tabs) {
      if (typeof tabs !== 'object' || !tabs.about || !tabs.support || !tabs.tutorial || !tabs.terms) {
        return res.status(400).json({ error: 'Tabs must contain about, support, tutorial, and terms sections' });
      }
      fs.writeFileSync(TUTORIAL_TABS_PATH, JSON.stringify(tabs, null, 2), 'utf8');
      fs.writeFileSync(TUTORIAL_TXT_PATH, tabs.tutorial, 'utf8');
    } else if (content) {
      if (typeof content !== 'string') {
        return res.status(400).json({ error: 'Content must be a string' });
      }
      fs.writeFileSync(TUTORIAL_TXT_PATH, content, 'utf8');
    } else {
      return res.status(400).json({ error: 'Either content or tabs must be provided' });
    }

    return res.json({ success: true, message: 'Tutorial content saved successfully' });
  } catch (error) {
    logger.error('Failed to save tutorial:', error);
    return res.status(500).json({ error: 'Failed to save tutorial content' });
  }
});

module.exports = router;
