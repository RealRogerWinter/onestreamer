const UserRepository = require('../../../database/repository/UserRepository');

// Helper: build a repo with jest.fn() mocks for the three DB primitives.
function makeRepo() {
    const getAsync = jest.fn();
    const runAsync = jest.fn();
    const allAsync = jest.fn();
    const repo = new UserRepository({ getAsync, runAsync, allAsync });
    return { repo, getAsync, runAsync, allAsync };
}

// Collapse all internal whitespace so we can assert on the SQL "shape"
// without being sensitive to formatting.
const norm = (s) => s.replace(/\s+/g, ' ').trim();

describe('UserRepository', () => {
    describe('getById', () => {
        it('passes id to getAsync with the correct SQL', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 42, email: 'a@b.c' });

            const result = await repo.getById(42);

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM users WHERE id = ?');
            expect(params).toEqual([42]);
            expect(result).toEqual({ id: 42, email: 'a@b.c' });
        });
    });

    describe('getByEmail', () => {
        it('passes email to getAsync with the correct SQL', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, email: 'foo@bar.com' });

            await repo.getByEmail('foo@bar.com');

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT * FROM users WHERE email = ?');
            expect(params).toEqual(['foo@bar.com']);
        });
    });

    describe('getByUsername', () => {
        it('uses the explicit column projection (not SELECT *)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, username: 'alice' });

            await repo.getByUsername('alice');

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];

            // Must not be SELECT * — this is the byte-equivalent migration
            // of the original AccountService.getUserByUsername projection.
            expect(sql).not.toMatch(/SELECT\s+\*/i);

            // Verify the exact column list (in order) matches the legacy SQL.
            const expectedCols = [
                'id', 'email', 'username', 'password', 'created_at',
                'updated_at', 'last_login', 'is_verified', 'is_admin',
                'is_moderator', 'is_banned', 'oauth_provider',
                'username_changed', 'avatar_url', 'description'
            ];
            for (const col of expectedCols) {
                expect(sql).toContain(col);
            }
            expect(norm(sql)).toBe(
                `SELECT ${expectedCols.join(', ')} FROM users WHERE username = ?`
            );
            expect(params).toEqual(['alice']);
        });
    });

    describe('create', () => {
        it('generates the correct INSERT with all 7 columns and 6 placeholders', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 99, changes: 1 });

            const result = await repo.create({
                email: 'a@b.c',
                username: 'alice',
                password: 'hashed-pw',
                oauthProvider: 'google',
                oauthId: 'g-123',
                verificationToken: 'tok-xyz'
            });

            expect(runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = runAsync.mock.calls[0];

            // Verify all 6 columns appear (the INSERT lists 6 cols; the 7th
            // bit of context is that there are 6 placeholders matching them).
            expect(sql).toMatch(
                /INSERT\s+INTO\s+users\s*\(\s*email\s*,\s*username\s*,\s*password\s*,\s*oauth_provider\s*,\s*oauth_id\s*,\s*verification_token\s*\)/i
            );
            // 6 placeholders for 6 columns.
            const placeholderCount = (sql.match(/\?/g) || []).length;
            expect(placeholderCount).toBe(6);

            expect(params).toEqual([
                'a@b.c', 'alice', 'hashed-pw', 'google', 'g-123', 'tok-xyz'
            ]);
            expect(result).toEqual({ id: 99, changes: 1 });
        });

        it('defaults missing optional oauth fields to null', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 7, changes: 1 });

            await repo.create({
                email: 'a@b.c',
                username: 'alice',
                password: 'pw'
            });

            const [, params] = runAsync.mock.calls[0];
            // email, username, password, oauthProvider=null, oauthId=null, verificationToken=null
            expect(params).toEqual(['a@b.c', 'alice', 'pw', null, null, null]);
        });
    });

    describe('update', () => {
        it('with a single field generates UPDATE ... SET <col> = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.update(5, { is_admin: 1 });

            expect(runAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            // Value first, then id (id is appended last).
            expect(params).toEqual([1, 5]);
        });

        it('with multiple fields generates a single UPDATE with placeholders in key order', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.update(42, {
                is_admin: 1,
                is_banned: 0,
                avatar_url: 'http://example.com/a.png'
            });

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET is_admin = ?, is_banned = ?, avatar_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            );
            // Object.keys() order is insertion order for string keys, so
            // we can assert positional values + id last.
            expect(params).toEqual([1, 0, 'http://example.com/a.png', 42]);
        });

        it('auto-stamps updated_at = CURRENT_TIMESTAMP (literal, not parameterized)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.update(1, { password: 'newpw' });

            const [sql, params] = runAsync.mock.calls[0];
            // The CURRENT_TIMESTAMP must appear as a SQL literal, not as a
            // ? placeholder bound to a JS value — otherwise the DB wouldn't
            // evaluate it as "now".
            expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
            // Only one ? for password + one ? for id => 2 placeholders.
            const placeholderCount = (sql.match(/\?/g) || []).length;
            expect(placeholderCount).toBe(2);
            expect(params).toHaveLength(2);
            expect(params).toEqual(['newpw', 1]);
        });

        it('with an empty fields object short-circuits to { id: 0, changes: 0 } without calling runAsync', async () => {
            const { repo, runAsync } = makeRepo();

            const result = await repo.update(99, {});

            expect(runAsync).not.toHaveBeenCalled();
            expect(result).toEqual({ id: 0, changes: 0 });
        });

        it('parameterizes values (no value interpolation into the SQL string)', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            const maliciousValue = "'; DROP TABLE users; --";
            await repo.update(1, { description: maliciousValue });

            const [sql, params] = runAsync.mock.calls[0];
            // The malicious string must show up in params, NOT in the SQL.
            expect(sql).not.toContain(maliciousValue);
            expect(sql).not.toContain('DROP');
            expect(params).toEqual([maliciousValue, 1]);
        });
    });

    describe('constructor defaults', () => {
        it('a default-constructed instance exposes the 5 public methods', () => {
            // We don't actually call any method here — that would touch the
            // real DB primitives. We only verify the method surface exists,
            // which is what backwards compatibility requires.
            const repo = new UserRepository();
            expect(typeof repo.getById).toBe('function');
            expect(typeof repo.getByEmail).toBe('function');
            expect(typeof repo.getByUsername).toBe('function');
            expect(typeof repo.create).toBe('function');
            expect(typeof repo.update).toBe('function');
        });
    });

    // ----------------------------------------------------------------------
    // PR-Q2 additions
    // ----------------------------------------------------------------------

    describe('getByOAuth', () => {
        it('passes (provider, oauthId) in order with the correct SQL', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 1, oauth_provider: 'google' });

            await repo.getByOAuth('google', 'g-123');

            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT * FROM users WHERE oauth_provider = ? AND oauth_id = ?'
            );
            expect(params).toEqual(['google', 'g-123']);
        });
    });

    describe('updateLastLogin', () => {
        it('uses CURRENT_TIMESTAMP as a SQL literal and does NOT touch updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.updateLastLogin(7);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'
            );
            // The legacy SQL did NOT stamp updated_at — preserve that.
            expect(sql).not.toContain('updated_at');
            expect(params).toEqual([7]);
        });
    });

    describe('markVerified', () => {
        it('sets is_verified = 1 and clears verification_token without touching updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.markVerified(42);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET is_verified = 1, verification_token = NULL WHERE id = ?'
            );
            expect(sql).not.toContain('updated_at');
            expect(params).toEqual([42]);
        });
    });

    describe('findByResetToken', () => {
        it('filters with datetime(\'now\') and returns the legacy projection', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 5, reset_token_expires: '2026-01-01' });

            await repo.findByResetToken('tok-abc');

            const [sql, params] = getAsync.mock.calls[0];
            // Projection: id, reset_token_expires only.
            expect(sql).toMatch(/SELECT\s+id\s*,\s*reset_token_expires\s+FROM\s+users/i);
            // Live-token filter.
            expect(sql).toContain("reset_token_expires > datetime('now')");
            expect(params).toEqual(['tok-abc']);
        });
    });

    describe('setPasswordAndClearResetToken', () => {
        it('clears both reset_token and reset_token_expires and does NOT touch updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.setPasswordAndClearResetToken(3, 'newhash');

            const [sql, params] = runAsync.mock.calls[0];
            expect(sql).toMatch(/UPDATE users SET password = \?, reset_token = NULL, reset_token_expires = NULL/);
            expect(sql).not.toContain('updated_at');
            expect(params).toEqual(['newhash', 3]);
        });
    });

    describe('deleteById', () => {
        it('issues a parameterized DELETE on id', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.deleteById(11);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe('DELETE FROM users WHERE id = ?');
            expect(params).toEqual([11]);
        });
    });

    describe('listForAdmin', () => {
        it('with no search produces the bare list (no WHERE, ORDER BY created_at DESC)', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.listForAdmin();

            const [sql, params] = allAsync.mock.calls[0];
            expect(sql).not.toMatch(/WHERE/i);
            expect(sql).toMatch(/ORDER BY created_at DESC/);
            expect(params).toEqual([]);
        });

        it('with a search adds a username/email LIKE filter wrapped in %', async () => {
            const { repo, allAsync } = makeRepo();
            allAsync.mockResolvedValue([]);

            await repo.listForAdmin({ search: 'alice' });

            const [sql, params] = allAsync.mock.calls[0];
            expect(sql).toMatch(/WHERE username LIKE \? OR email LIKE \?/);
            expect(params).toEqual(['%alice%', '%alice%']);
        });
    });

    describe('restoreFromDeletion', () => {
        it('only restores rows where account_status = pending_deletion and returns the run result', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 0 });

            const result = await repo.restoreFromDeletion(9);

            const [sql, params] = runAsync.mock.calls[0];
            expect(sql).toMatch(/WHERE id = \? AND account_status = 'pending_deletion'/);
            expect(sql).toContain('account_status = \'active\'');
            expect(params).toEqual([9]);
            // Caller (AccountService.restoreAccount) inspects .changes to
            // detect a no-op restore.
            expect(result).toEqual({ id: 0, changes: 0 });
        });
    });

    // ----------------------------------------------------------------------
    // PR-Q3 additions
    // ----------------------------------------------------------------------

    describe('getUsernameById', () => {
        it('uses the minimal `username` projection by id', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ username: 'alice' });

            const result = await repo.getUsernameById(7);

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe('SELECT username FROM users WHERE id = ?');
            // Must not be SELECT * — this is the byte-equivalent migration
            // of the legacy `SELECT username FROM users WHERE id = ?` site.
            expect(sql).not.toMatch(/SELECT\s+\*/i);
            expect(params).toEqual([7]);
            expect(result).toEqual({ username: 'alice' });
        });
    });

    describe('getByIdOrUsername', () => {
        it('passes (usernameValue, idValue) in order with the correct SQL', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue({ id: 3, username: 'bob' });

            const result = await repo.getByIdOrUsername('bob', 3);

            expect(getAsync).toHaveBeenCalledTimes(1);
            const [sql, params] = getAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'SELECT id, username FROM users WHERE username = ? OR id = ?'
            );
            expect(params).toEqual(['bob', 3]);
            expect(result).toEqual({ id: 3, username: 'bob' });
        });

        it('accepts a zero id when the value is non-numeric (caller-coerced)', async () => {
            const { repo, getAsync } = makeRepo();
            getAsync.mockResolvedValue(undefined);

            // Mirrors how callers like ContinuousRecordingService coerce
            // non-numeric identities: `parseInt(value) || 0`.
            await repo.getByIdOrUsername('not-a-number', 0);

            const [, params] = getAsync.mock.calls[0];
            expect(params).toEqual(['not-a-number', 0]);
        });
    });

    describe('banFromChat', () => {
        it('mirrors the legacy moderation SQL byte-for-byte and does NOT touch updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.banFromChat(42, 7);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET chat_banned = 1, chat_banned_at = CURRENT_TIMESTAMP, chat_banned_by = ? WHERE id = ?'
            );
            // CURRENT_TIMESTAMP must be a SQL literal, not a parameter.
            expect(sql).toContain('chat_banned_at = CURRENT_TIMESTAMP');
            expect(sql).not.toContain('updated_at');
            // (moderator id, target id) order.
            expect(params).toEqual([7, 42]);
        });
    });

    describe('setChatTimeout', () => {
        it('parameterizes timeout_until and timeout_by and does NOT touch updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            const iso = '2026-06-01T00:00:00.000Z';
            await repo.setChatTimeout(42, 7, iso);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET chat_timeout_until = ?, chat_timeout_by = ? WHERE id = ?'
            );
            expect(sql).not.toContain('updated_at');
            expect(sql).not.toContain('CURRENT_TIMESTAMP');
            // (iso, moderator id, target id) order.
            expect(params).toEqual([iso, 7, 42]);
        });
    });

    describe('banFromStreaming', () => {
        it('mirrors the legacy admin moderation SQL byte-for-byte and does NOT touch updated_at', async () => {
            const { repo, runAsync } = makeRepo();
            runAsync.mockResolvedValue({ id: 0, changes: 1 });

            await repo.banFromStreaming(42, 7);

            const [sql, params] = runAsync.mock.calls[0];
            expect(norm(sql)).toBe(
                'UPDATE users SET streaming_banned = 1, streaming_banned_at = CURRENT_TIMESTAMP, streaming_banned_by = ? WHERE id = ?'
            );
            expect(sql).toContain('streaming_banned_at = CURRENT_TIMESTAMP');
            expect(sql).not.toContain('updated_at');
            expect(params).toEqual([7, 42]);
        });
    });
});
