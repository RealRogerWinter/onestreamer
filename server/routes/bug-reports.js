const express = require('express');
const router = express.Router();
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { authenticateToken, optionalAuth } = require('../middleware/auth');

const dbPath = path.join(__dirname, '..', 'data', 'onestreamer.db');
const db = new sqlite3.Database(dbPath);

// Submit a bug report (authentication optional)
router.post('/', optionalAuth, async (req, res) => {
    try {
        const { description, username, sessionData } = req.body;
        
        if (!description || description.trim().length === 0) {
            return res.status(400).json({ error: 'Bug description is required' });
        }

        if (description.length > 2000) {
            return res.status(400).json({ error: 'Description too long (max 2000 characters)' });
        }

        // Get user info and IP
        const userId = req.user ? req.user.id : null;
        const reportUsername = userId ? req.user.username : (username || 'Anonymous');
        const ipAddress = req.headers['x-forwarded-for'] || req.connection.remoteAddress || req.ip;
        const userAgent = req.headers['user-agent'] || '';
        
        // Prepare session data
        const fullSessionData = JSON.stringify({
            ...sessionData,
            serverTimestamp: new Date().toISOString(),
            requestHeaders: {
                'user-agent': userAgent,
                'accept-language': req.headers['accept-language'],
                'referer': req.headers['referer']
            }
        });

        // Insert bug report
        const query = `
            INSERT INTO bug_reports (
                user_id, username, ip_address, description, 
                session_data, user_agent, url, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;

        db.run(query, [
            userId,
            reportUsername,
            ipAddress,
            description.trim(),
            fullSessionData,
            userAgent,
            sessionData?.url || '',
            'new'
        ], function(err) {
            if (err) {
                console.error('Error inserting bug report:', err);
                return res.status(500).json({ error: 'Failed to submit bug report' });
            }

            console.log(`Bug report submitted: ID ${this.lastID} by ${reportUsername}`);
            
            res.json({
                success: true,
                message: 'Bug report submitted successfully',
                reportId: this.lastID
            });
        });

    } catch (error) {
        console.error('Error processing bug report:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Get all bug reports (admin only)
router.get('/', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id], (err, user) => {
            if (err || !user || !user.is_admin) {
                return res.status(403).json({ error: 'Admin access required' });
            }

            const { status, priority, page = 1, limit = 20 } = req.query;
            const offset = (page - 1) * limit;
            
            let query = `
                SELECT 
                    br.*,
                    u.username as reporter_username,
                    ru.username as resolver_username
                FROM bug_reports br
                LEFT JOIN users u ON br.user_id = u.id
                LEFT JOIN users ru ON br.resolved_by = ru.id
                WHERE 1=1
            `;
            
            const params = [];
            
            if (status) {
                query += ' AND br.status = ?';
                params.push(status);
            }
            
            if (priority) {
                query += ' AND br.priority = ?';
                params.push(priority);
            }
            
            query += ' ORDER BY br.created_at DESC LIMIT ? OFFSET ?';
            params.push(parseInt(limit), offset);
            
            db.all(query, params, (err, reports) => {
                if (err) {
                    console.error('Error fetching bug reports:', err);
                    return res.status(500).json({ error: 'Failed to fetch bug reports' });
                }
                
                // Get total count for pagination
                let countQuery = 'SELECT COUNT(*) as total FROM bug_reports WHERE 1=1';
                const countParams = [];
                
                if (status) {
                    countQuery += ' AND status = ?';
                    countParams.push(status);
                }
                
                if (priority) {
                    countQuery += ' AND priority = ?';
                    countParams.push(priority);
                }
                
                db.get(countQuery, countParams, (err, count) => {
                    if (err) {
                        console.error('Error counting bug reports:', err);
                        return res.status(500).json({ error: 'Failed to count bug reports' });
                    }
                    
                    res.json({
                        reports: reports.map(report => ({
                            ...report,
                            session_data: report.session_data ? JSON.parse(report.session_data) : null
                        })),
                        pagination: {
                            total: count.total,
                            page: parseInt(page),
                            limit: parseInt(limit),
                            pages: Math.ceil(count.total / limit)
                        }
                    });
                });
            });
        });
    } catch (error) {
        console.error('Error in bug reports endpoint:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update bug report status (admin only)
router.patch('/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id], (err, user) => {
            if (err || !user || !user.is_admin) {
                return res.status(403).json({ error: 'Admin access required' });
            }

            const { id } = req.params;
            const { status, priority, admin_notes } = req.body;
            
            const updates = [];
            const params = [];
            
            if (status) {
                updates.push('status = ?');
                params.push(status);
                
                if (status === 'resolved') {
                    updates.push('resolved_at = CURRENT_TIMESTAMP');
                    updates.push('resolved_by = ?');
                    params.push(req.user.id);
                }
            }
            
            if (priority) {
                updates.push('priority = ?');
                params.push(priority);
            }
            
            if (admin_notes !== undefined) {
                updates.push('admin_notes = ?');
                params.push(admin_notes);
            }
            
            updates.push('updated_at = CURRENT_TIMESTAMP');
            
            params.push(id);
            
            const query = `UPDATE bug_reports SET ${updates.join(', ')} WHERE id = ?`;
            
            db.run(query, params, function(err) {
                if (err) {
                    console.error('Error updating bug report:', err);
                    return res.status(500).json({ error: 'Failed to update bug report' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Bug report not found' });
                }
                
                res.json({
                    success: true,
                    message: 'Bug report updated successfully'
                });
            });
        });
    } catch (error) {
        console.error('Error updating bug report:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Delete bug report (admin only)
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        // Check if user is admin
        db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id], (err, user) => {
            if (err || !user || !user.is_admin) {
                return res.status(403).json({ error: 'Admin access required' });
            }

            const { id } = req.params;
            
            db.run('DELETE FROM bug_reports WHERE id = ?', [id], function(err) {
                if (err) {
                    console.error('Error deleting bug report:', err);
                    return res.status(500).json({ error: 'Failed to delete bug report' });
                }
                
                if (this.changes === 0) {
                    return res.status(404).json({ error: 'Bug report not found' });
                }
                
                res.json({
                    success: true,
                    message: 'Bug report deleted successfully'
                });
            });
        });
    } catch (error) {
        console.error('Error deleting bug report:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;