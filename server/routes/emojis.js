/**
 * Custom emoji HTTP surface — extracted from `server/index.js` as part
 * of Phase 15B.3.b. 6 routes:
 *
 *   GET    /api/emojis                      — public list
 *   GET    /api/admin/emojis                — admin list (authenticateAdmin)
 *   POST   /api/admin/emojis                — admin upload (multipart)
 *   PUT    /api/admin/emojis/:id            — admin edit
 *   DELETE /api/admin/emojis/:id            — admin delete
 *   POST   /api/emojis/:code/use            — public usage tracker
 *
 * Auth: public list + usage tracker have no auth; admin CRUD uses
 * `authenticateAdmin` (JWT).
 *
 * The `emojiUpload` multer config is defined inline inside the factory
 * body (preserved verbatim from its pre-PR position between the GET-list
 * and POST-upload handlers). The `execPromise` util used by the POST
 * upload handler stays inside that handler's body (also verbatim — it
 * was already local-scope pre-PR).
 *
 * All deps are eager. Body byte-equivalent except for:
 *   - `app.X(...)` → `router.X(...)` at line starts
 */

const express = require('express');
const multer = require('multer');
const util = require('util');
const { exec } = require('child_process');

function createEmojiRouter(deps) {
    const {
        authenticateAdmin,
        database,
        fs,
        path,
        logger,
        uploadsDir,
        serverDir,
    } = deps;

    const router = express.Router();

    // Custom Emoji API endpoints
    router.get('/api/emojis', async (req, res) => {
        try {
            const emojis = await database.allAsync(`
                SELECT id, name, code, url, category, usage_count 
                FROM custom_emojis 
                WHERE is_active = 1 
                ORDER BY usage_count DESC, name ASC
            `);
        
            // Check for available formats for each emoji
            const fs = require('fs').promises;
            const path = require('path');
            const emojisWithFormats = await Promise.all(emojis.map(async (emoji) => {
                const basePath = emoji.url.replace(/\.[^/.]+$/, '');
                // serverDir is the absolute path to <repo>/server; the pre-PR
                // `path.join(__dirname, '..', basePath)` from server/index.js
                // resolved to <repo>/<basePath>. Preserve identical resolution.
                const baseFile = path.join(serverDir, '..', basePath);
            
                const formats = {
                    avif: emoji.url,
                    gif: null,
                    webp: null,
                    png: null
                };
            
                // Check for GIF
                try {
                    await fs.access(baseFile + '.gif');
                    formats.gif = basePath + '.gif';
                } catch {}
            
                // Check for WebP
                try {
                    await fs.access(baseFile + '.webp');
                    formats.webp = basePath + '.webp';
                } catch {}
            
                // Check for PNG
                try {
                    await fs.access(baseFile + '.png');
                    formats.png = basePath + '.png';
                } catch {}
            
                return {
                    ...emoji,
                    formats
                };
            }));
        
            res.json(emojisWithFormats);
        } catch (error) {
            logger.error({ err: error }, 'Error fetching emojis');
            res.status(500).json({ error: 'Failed to fetch emojis' });
        }
    });


    // Get all emojis for admin panel
    router.get('/api/admin/emojis', authenticateAdmin, async (req, res) => {
        try {
            const emojis = await database.allAsync(`
                SELECT e.*, u.username as created_by_username
                FROM custom_emojis e
                LEFT JOIN users u ON e.created_by = u.id
                ORDER BY e.created_at DESC
            `);
            res.json(emojis);
        } catch (error) {
            logger.error({ err: error }, 'Error fetching admin emojis');
            res.status(500).json({ error: 'Failed to fetch emojis' });
        }
    });

    // Upload new emoji
    const emojiStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            // Pre-PR `path.join(__dirname, 'uploads', 'emojis')` from server/
            // index.js resolved to <repo>/server/uploads/emojis. serverDir is
            // the absolute path to <repo>/server, so this preserves resolution.
            const dir = path.join(serverDir, 'uploads', 'emojis');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, uniqueSuffix + path.extname(file.originalname));
        }
    });

    const emojiUpload = multer({ 
        storage: emojiStorage,
        limits: { fileSize: 500000 }, // 500KB max
        fileFilter: (req, file, cb) => {
            const allowedTypes = /jpeg|jpg|png|gif|webp|avif/;
            const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
            const allowedMimeTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
            const mimetype = allowedMimeTypes.includes(file.mimetype);
        
            if (mimetype && extname) {
                return cb(null, true);
            } else {
                cb(new Error('Only image files (JPEG, PNG, GIF, WebP, AVIF) are allowed'));
            }
        }
    });

    router.post('/api/admin/emojis', authenticateAdmin, emojiUpload.single('emoji'), async (req, res) => {
        try {
            const { name, code, category } = req.body;
            const user = req.user;
        
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
        
            if (!name || !code) {
                // Clean up uploaded file
                fs.unlinkSync(req.file.path);
                return res.status(400).json({ error: 'Name and code are required' });
            }
        
            // Ensure code is formatted correctly (without colons)
            const cleanCode = code.replace(/^:+|:+$/g, '');
        
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);
        
            const fileExt = path.extname(req.file.filename).toLowerCase();
            let finalFilePath = req.file.path;
            let finalFilename = req.file.filename;
        
            // Convert all uploaded images to Safari-compatible AVIF format
            try {
                if (fileExt === '.avif') {
                    // Re-encode existing AVIF with Safari-compatible settings
                    logger.info({ filename: req.file.filename }, 'Re-encoding AVIF file for Safari compatibility');
                
                    // First decode to PNG
                    const tempPng = req.file.path.replace('.avif', '_temp.png');
                    await execPromise(`avifdec "${req.file.path}" "${tempPng}" 2>/dev/null`);
                
                    // Re-encode with Safari-compatible settings
                    const tempAvif = req.file.path + '.new';
                    await execPromise(`avifenc --qcolor 85 --speed 6 --yuv 420 --range limited --cicp 1/13/6 --autotiling --jobs all "${tempPng}" "${tempAvif}" 2>/dev/null`);
                
                    // Replace original with converted version
                    if (fs.existsSync(tempAvif) && fs.statSync(tempAvif).size > 0) {
                        fs.unlinkSync(req.file.path);
                        fs.renameSync(tempAvif, req.file.path);
                        logger.info('Successfully re-encoded AVIF for Safari compatibility');
                    }
                
                    // Clean up temp files
                    if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng);
                    if (fs.existsSync(tempAvif)) fs.unlinkSync(tempAvif);
                } else {
                    // Convert PNG/JPG/GIF/WebP to Safari-compatible AVIF
                    logger.info({ fileExt, filename: req.file.filename }, 'Converting to Safari-compatible AVIF');
                
                    const avifPath = req.file.path.replace(fileExt, '.avif');
                    const avifFilename = req.file.filename.replace(fileExt, '.avif');
                
                    // For GIF, extract first frame to PNG first
                    let sourceFile = req.file.path;
                    if (fileExt === '.gif') {
                        const tempPng = req.file.path.replace('.gif', '_frame.png');
                        await execPromise(`ffmpeg -i "${req.file.path}" -vframes 1 -y "${tempPng}" 2>/dev/null`);
                        if (fs.existsSync(tempPng)) {
                            sourceFile = tempPng;
                        }
                    }
                
                    // Convert to AVIF with Safari-compatible settings
                    await execPromise(`avifenc --qcolor 85 --speed 6 --yuv 420 --range limited --cicp 1/13/6 --autotiling --jobs all "${sourceFile}" "${avifPath}" 2>/dev/null`);
                
                    // Check if conversion succeeded
                    if (fs.existsSync(avifPath) && fs.statSync(avifPath).size > 0) {
                        // Delete original file
                        fs.unlinkSync(req.file.path);
                    
                        // Clean up temp PNG if it was created for GIF
                        if (fileExt === '.gif' && sourceFile !== req.file.path) {
                            fs.unlinkSync(sourceFile);
                        }
                    
                        finalFilePath = avifPath;
                        finalFilename = avifFilename;
                        logger.info('Successfully converted to Safari-compatible AVIF');
                    } else {
                        // Clean up temp PNG if it was created for GIF
                        if (fileExt === '.gif' && sourceFile !== req.file.path) {
                            fs.unlinkSync(sourceFile);
                        }
                        logger.info('Warning: AVIF conversion failed, using original file');
                    }
                }
            } catch (conversionError) {
                logger.error({ err: conversionError }, 'Warning: Image conversion failed, using original file');
                // Continue with original file if conversion fails
            }
        
            const url = `/uploads/emojis/${finalFilename}`;
        
            const result = await database.runAsync(`
                INSERT INTO custom_emojis (name, code, file_path, url, category, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [name, cleanCode, finalFilePath, url, category || 'general', user.id]);
        
            res.json({ 
                id: result.id,
                name,
                code: cleanCode,
                url,
                category: category || 'general',
                message: 'Emoji uploaded successfully' 
            });
        } catch (error) {
            logger.error({ err: error }, 'Error uploading emoji');
            if (req.file) {
                fs.unlinkSync(req.file.path);
            }
            res.status(500).json({ error: 'Failed to upload emoji' });
        }
    });

    // Update emoji
    router.put('/api/admin/emojis/:id', authenticateAdmin, express.json(), async (req, res) => {
        try {
            const { id } = req.params;
            const { name, code, category, is_active } = req.body;
        
            // Ensure code is formatted correctly (without colons)
            const cleanCode = code ? code.replace(/^:+|:+$/g, '') : undefined;
        
            const updates = [];
            const values = [];
        
            if (name !== undefined) {
                updates.push('name = ?');
                values.push(name);
            }
            if (code !== undefined) {
                updates.push('code = ?');
                values.push(cleanCode);
            }
            if (category !== undefined) {
                updates.push('category = ?');
                values.push(category);
            }
            if (is_active !== undefined) {
                updates.push('is_active = ?');
                values.push(is_active ? 1 : 0);
            }
        
            if (updates.length === 0) {
                return res.status(400).json({ error: 'No updates provided' });
            }
        
            updates.push('updated_at = CURRENT_TIMESTAMP');
            values.push(id);
        
            await database.runAsync(`
                UPDATE custom_emojis 
                SET ${updates.join(', ')}
                WHERE id = ?
            `, values);
        
            res.json({ message: 'Emoji updated successfully' });
        } catch (error) {
            logger.error({ err: error }, 'Error updating emoji');
            res.status(500).json({ error: 'Failed to update emoji' });
        }
    });

    // Delete emoji
    router.delete('/api/admin/emojis/:id', authenticateAdmin, async (req, res) => {
        try {
            const { id } = req.params;
        
            // Get emoji info first
            const emoji = await database.getAsync('SELECT file_path FROM custom_emojis WHERE id = ?', [id]);
        
            if (!emoji) {
                return res.status(404).json({ error: 'Emoji not found' });
            }
        
            // Delete from database
            await database.runAsync('DELETE FROM custom_emojis WHERE id = ?', [id]);
        
            // Delete file if it exists
            if (emoji.file_path && fs.existsSync(emoji.file_path)) {
                fs.unlinkSync(emoji.file_path);
            }
        
            res.json({ message: 'Emoji deleted successfully' });
        } catch (error) {
            logger.error({ err: error }, 'Error deleting emoji');
            res.status(500).json({ error: 'Failed to delete emoji' });
        }
    });

    // Track emoji usage
    router.post('/api/emojis/:code/use', express.json(), async (req, res) => {
        try {
            const { code } = req.params;
        
            await database.runAsync(`
                UPDATE custom_emojis 
                SET usage_count = usage_count + 1 
                WHERE code = ? AND is_active = 1
            `, [code]);
        
            res.json({ success: true });
        } catch (error) {
            logger.error({ err: error }, 'Error tracking emoji usage');
            res.status(500).json({ error: 'Failed to track emoji usage' });
        }
    });

    return router;
}

module.exports = createEmojiRouter;
