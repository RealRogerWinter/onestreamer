> Archived 2026-05-23 — historical note, not maintained. See /docs/features/points-and-economy.md for current state.

# POINTS SYSTEM REFACTOR - IMPLEMENTATION DETAILS

## CURRENT SERVICES USING POINTS

### 1. AccountService.js
- `calculatePoints()` - REMOVE
- `calculateAndUpdatePoints()` - REMOVE
- `getUserStats()` - KEEP (but return points_balance)

### 2. TimeTrackingService.js
- Calls `calculateAndUpdatePoints()` after updating time
- Sends socket updates with recalculated points
- **CHANGE TO**: Add incremental points

### 3. ShopService.js
- Line 218: `UPDATE user_stats SET points = ?` - WRONG!
- Line 271: Same issue for selling items
- **CHANGE TO**: Use addPoints/subtractPoints

### 4. Auth Routes
- `/api/auth/me` - Returns calculated points
- **CHANGE TO**: Return points_balance

### 5. Client (App.tsx)
- Displays userPoints state
- Updates via socket events
- **NO CHANGE NEEDED** (just receives different value)

## STEP-BY-STEP IMPLEMENTATION

### Step 1: Database Schema Changes

```sql
-- Add new columns to user_stats
ALTER TABLE user_stats ADD COLUMN points_balance INTEGER DEFAULT 0;

-- Create transactions table
CREATE TABLE IF NOT EXISTS points_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id)
);

-- Create index for fast queries
CREATE INDEX idx_points_transactions_user_id ON points_transactions(user_id);
CREATE INDEX idx_points_transactions_created_at ON points_transactions(created_at);
```

### Step 2: New AccountService Methods

```javascript
// AccountService.js - ADD these methods

async addPoints(userId, amount, type, description, metadata = null) {
    if (amount <= 0) {
        throw new Error('Amount must be positive');
    }
    
    // Get current balance
    const stats = await this.getUserStats(userId);
    const currentBalance = stats?.points_balance || 0;
    const newBalance = currentBalance + amount;
    
    // Update balance
    await runAsync(
        'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
        [newBalance, userId]
    );
    
    // Record transaction
    await this.recordTransaction(userId, amount, newBalance, type, description, metadata);
    
    return newBalance;
}

async subtractPoints(userId, amount, type, description, metadata = null) {
    if (amount <= 0) {
        throw new Error('Amount must be positive');
    }
    
    // Get current balance
    const stats = await this.getUserStats(userId);
    const currentBalance = stats?.points_balance || 0;
    
    if (currentBalance < amount) {
        throw new Error('Insufficient points balance');
    }
    
    const newBalance = currentBalance - amount;
    
    // Update balance
    await runAsync(
        'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
        [newBalance, userId]
    );
    
    // Record transaction (negative amount)
    await this.recordTransaction(userId, -amount, newBalance, type, description, metadata);
    
    return newBalance;
}

async getPointsBalance(userId) {
    const stats = await this.getUserStats(userId);
    return stats?.points_balance || 0;
}

async recordTransaction(userId, amount, balanceAfter, type, description, metadata = null) {
    await runAsync(
        `INSERT INTO points_transactions 
         (user_id, amount, balance_after, type, description, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [userId, amount, balanceAfter, type, description, 
         metadata ? JSON.stringify(metadata) : null]
    );
}

async getTransactionHistory(userId, limit = 50) {
    return await allAsync(
        `SELECT * FROM points_transactions 
         WHERE user_id = ? 
         ORDER BY created_at DESC 
         LIMIT ?`,
        [userId, limit]
    );
}
```

### Step 3: Update TimeTrackingService

```javascript
// TimeTrackingService.js - CHANGE sendRealTimeUpdate()

async sendRealTimeUpdate(userId, sessionType) {
    if (!this.io) return;
    
    try {
        // Define point awards
        const POINTS_PER_UPDATE = {
            streaming: 500,  // per 25 seconds
            viewing: 200     // per 25 seconds
        };
        
        const pointsToAdd = POINTS_PER_UPDATE[sessionType] || 0;
        
        if (pointsToAdd > 0) {
            // Add points to balance
            const newBalance = await this.accountService.addPoints(
                userId,
                pointsToAdd,
                sessionType,
                `${sessionType === 'streaming' ? 'Streaming' : 'Viewing'} reward`
            );
            
            // Get updated stats
            const userStats = await this.accountService.getUserStats(userId);
            
            // Send update with new balance
            const updateData = {
                userId,
                points: newBalance,  // Send the new balance
                pointsAdded: pointsToAdd,  // Also send what was added
                sessionType,
                pointSource: sessionType,
                timestamp: Date.now()
            };
            
            this.io.emit('time-stats-update', updateData);
        }
    } catch (error) {
        console.error(`Error updating points for ${userId}:`, error);
    }
}

// For chat messages
async trackChatMessage(userId) {
    try {
        // ... existing chat tracking code ...
        
        // Add points for chat
        const CHAT_POINTS = 50;
        const newBalance = await this.accountService.addPoints(
            userId,
            CHAT_POINTS,
            'chat',
            'Chat message reward'
        );
        
        // Send update
        await this.sendRealTimeStatsUpdate(userId, 'chat');
    } catch (error) {
        console.error(`Failed to track chat for ${userId}:`, error);
    }
}
```

### Step 4: Update ShopService

```javascript
// ShopService.js - CHANGE purchaseItem()

async purchaseItem(userId, itemId, quantity = 1) {
    // ... validation code ...
    
    const totalCost = finalPrice * quantity;
    
    try {
        // Deduct points using new method
        const newBalance = await this.accountService.subtractPoints(
            userId,
            totalCost,
            'purchase',
            `Purchased ${quantity}x ${shopItem.display_name}`,
            { itemId, quantity, pricePerItem: finalPrice }
        );
        
        // Add to inventory
        await this.inventoryService.addItemToInventory(userId, itemId, quantity);
        
        // Update stock if limited
        if (shopItem.stock_limit !== 0) {
            await runAsync(
                'UPDATE shop_items SET stock_limit = stock_limit - ? WHERE id = ?',
                [quantity, shopItem.id]
            );
        }
        
        return {
            success: true,
            item: shopItem.display_name,
            quantity,
            totalCost,
            remainingPoints: newBalance
        };
    } catch (error) {
        throw error;
    }
}

// Similar changes for sellItem() - use addPoints()
```

### Step 5: Update Auth Routes

```javascript
// routes/auth.js - CHANGE /me endpoint

router.get('/me', authenticateToken, async (req, res) => {
    try {
        const user = await authService.accountService.getUserById(req.user.id);
        const stats = await authService.accountService.getUserStats(req.user.id);
        
        // Use points_balance, not calculated points
        const points = stats?.points_balance || 0;
        
        res.json({
            user,
            stats: {
                ...stats,
                points  // This is now the balance, not calculated
            }
        });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});
```

### Step 6: Data Migration Script

```javascript
// migrate-points.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

async function migratePoints() {
    const db = new sqlite3.Database(path.join(__dirname, 'server/data/onestreamer.db'));
    
    console.log('Starting points migration...');
    
    // Add new column if not exists
    await db.run(`
        ALTER TABLE user_stats 
        ADD COLUMN points_balance INTEGER DEFAULT 0
    `).catch(e => console.log('Column might already exist'));
    
    // Create transactions table
    await db.run(`
        CREATE TABLE IF NOT EXISTS points_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            type VARCHAR(50) NOT NULL,
            description TEXT,
            metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `);
    
    // Migrate existing points to balance
    const users = await db.all('SELECT * FROM user_stats');
    
    for (const user of users) {
        // Use the already recalculated points value
        const balance = user.points || 0;
        
        // Set initial balance
        await db.run(
            'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
            [balance, user.user_id]
        );
        
        // Record initial transaction
        if (balance > 0) {
            await db.run(
                `INSERT INTO points_transactions 
                 (user_id, amount, balance_after, type, description)
                 VALUES (?, ?, ?, ?, ?)`,
                [user.user_id, balance, balance, 'migration', 
                 'Initial balance from activity history']
            );
        }
        
        console.log(`Migrated user ${user.user_id}: ${balance} points`);
    }
    
    console.log('Migration complete!');
}

migratePoints();
```

## TESTING CHECKLIST

- [ ] Points balance persists between sessions
- [ ] Streaming adds +500 points per 25 seconds
- [ ] Viewing adds +200 points per 25 seconds  
- [ ] Chat adds +50 points per message
- [ ] Shop purchases deduct points correctly
- [ ] Can't purchase if insufficient balance
- [ ] Transaction history is recorded
- [ ] Points display shows balance, not calculated value
- [ ] Socket updates send correct balance
- [ ] Admin can manually add/remove points

## ROLLBACK PLAN

If issues arise:
1. Keep `points` column as backup
2. Can switch back to calculated system
3. Transaction log provides audit trail
4. No data loss possible

## BENEFITS

1. **True Economy**: Points are a real currency
2. **Shop Works**: Can actually buy and sell
3. **Flexibility**: Can have sales, bonuses, gifts
4. **Performance**: No constant recalculation
5. **Features**: Enables gambling, trading, leaderboards
6. **Audit Trail**: Complete transaction history