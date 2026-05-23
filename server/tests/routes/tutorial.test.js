const path = require('path');

// Mock fs before requiring the router. Use a real `path` module so the
// router's path.join() calls work normally.
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// Mock the heavy service modules. Both export classes with non-trivial
// constructors (passport init, DB open) that we don't want firing in tests.
const mockVerifyToken = jest.fn();
const mockGetUserById = jest.fn();

jest.mock('../../services/AuthService', () => {
  return jest.fn().mockImplementation(() => ({
    verifyToken: mockVerifyToken,
  }));
});

jest.mock('../../services/AccountService', () => {
  return jest.fn().mockImplementation(() => ({
    getUserById: mockGetUserById,
  }));
});

const fs = require('fs');
const express = require('express');
const request = require('supertest');

const tutorialRouter = require('../../routes/tutorial');

// Mirror the path constants used inside the router so we can match calls.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TUTORIAL_TXT_PATH = path.join(DATA_DIR, 'tutorial.txt');
const TUTORIAL_TABS_PATH = path.join(DATA_DIR, 'tutorial-tabs.json');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tutorial', tutorialRouter);
  return app;
}

describe('routes/tutorial', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe('GET /api/tutorial', () => {
    test('returns empty content when no tutorial files exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const res = await request(app).get('/api/tutorial');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: '' });
    });

    test('returns text content when only tutorial.txt exists', async () => {
      fs.existsSync.mockImplementation((p) => p === TUTORIAL_TXT_PATH);
      fs.readFileSync.mockReturnValue('Hello tutorial');

      const res = await request(app).get('/api/tutorial');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ content: 'Hello tutorial' });
      expect(fs.readFileSync).toHaveBeenCalledWith(TUTORIAL_TXT_PATH, 'utf8');
    });

    test('returns tabs when tutorial-tabs.json exists (priority over txt)', async () => {
      const tabs = {
        about: 'about',
        support: 'support',
        tutorial: 'tutorial body',
        terms: 'terms',
      };
      fs.existsSync.mockImplementation((p) => p === TUTORIAL_TABS_PATH);
      fs.readFileSync.mockReturnValue(JSON.stringify(tabs));

      const res = await request(app).get('/api/tutorial');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ tabs });
      expect(fs.readFileSync).toHaveBeenCalledWith(TUTORIAL_TABS_PATH, 'utf8');
    });

    test('returns 500 when fs.readFileSync throws', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('disk on fire');
      });
      // Silence the expected console.error noise.
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const res = await request(app).get('/api/tutorial');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to load tutorial content' });
    });
  });

  describe('POST /api/tutorial', () => {
    test('returns 401 when no Authorization header is sent', async () => {
      const res = await request(app)
        .post('/api/tutorial')
        .send({ content: 'anything' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
      expect(mockVerifyToken).not.toHaveBeenCalled();
    });

    test('returns 403 when token is invalid', async () => {
      mockVerifyToken.mockReturnValue(null);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer bad-token')
        .send({ content: 'anything' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Invalid or expired token' });
      expect(mockVerifyToken).toHaveBeenCalledWith('bad-token');
    });

    test('returns 403 when user is not admin', async () => {
      mockVerifyToken.mockReturnValue({ id: 42 });
      mockGetUserById.mockResolvedValue({ id: 42, is_admin: 0 });

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ content: 'anything' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Admin access required' });
    });

    test('returns 403 when user does not exist', async () => {
      mockVerifyToken.mockReturnValue({ id: 42 });
      mockGetUserById.mockResolvedValue(null);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ content: 'anything' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Admin access required' });
    });

    test('admin + valid string content writes tutorial.txt and returns success', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      fs.existsSync.mockReturnValue(true); // DATA_DIR exists

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ content: 'How to use the app' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        message: 'Tutorial content saved successfully',
      });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        TUTORIAL_TXT_PATH,
        'How to use the app',
        'utf8'
      );
      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    test('admin + valid tabs writes both tutorial-tabs.json and tutorial.txt', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      fs.existsSync.mockReturnValue(true);

      const tabs = {
        about: 'A',
        support: 'S',
        tutorial: 'T body',
        terms: 'TERMS',
      };

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ tabs });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        TUTORIAL_TABS_PATH,
        JSON.stringify(tabs, null, 2),
        'utf8'
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        TUTORIAL_TXT_PATH,
        'T body',
        'utf8'
      );
    });

    test('admin + tabs missing required keys returns 400', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      fs.existsSync.mockReturnValue(true);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ tabs: { about: 'A', support: 'S' } });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Tabs must contain about, support, tutorial, and terms sections',
      });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('admin + non-string content returns 400', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      fs.existsSync.mockReturnValue(true);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ content: { nested: 'object' } });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Content must be a string' });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('admin + neither content nor tabs returns 400', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      fs.existsSync.mockReturnValue(true);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'Either content or tabs must be provided',
      });
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('creates DATA_DIR when it does not exist', async () => {
      mockVerifyToken.mockReturnValue({ id: 1 });
      mockGetUserById.mockResolvedValue({ id: 1, is_admin: 1 });
      // DATA_DIR check returns false; force mkdir branch.
      fs.existsSync.mockImplementation((p) => p !== DATA_DIR);

      const res = await request(app)
        .post('/api/tutorial')
        .set('Authorization', 'Bearer good-token')
        .send({ content: 'hi' });

      expect(res.status).toBe(200);
      expect(fs.mkdirSync).toHaveBeenCalledWith(DATA_DIR, { recursive: true });
    });
  });
});
