> Archived 2026-05-23 — historical note, not maintained. See /docs/features/points-and-economy.md for current state.

# POINTS SYSTEM ARCHITECTURE REFACTOR PLAN

## CURRENT PROBLEM
Points are currently **calculated** from activity stats:
```javascript
points = (streamTime * multiplier) + (viewTime * multiplier) + (chatCount * multiplier)
```

This means:
- Points can't be spent (they'd just recalculate back)
- Points can't be manually awarded or removed
- Points are tied to historical activity, not current balance
- Shop purchases can't work properly

## CORRECT ARCHITECTURE
Points should be an **independent balance** that:
- Starts at 0 for new users
- Gets INCREMENTED when users earn points
- Gets DECREMENTED when users spend points
- Is completely separate from activity stats

## COMPREHENSIVE REFACTOR PLAN

### Phase 1: Database Changes
```sql
-- Current (WRONG)
user_stats {
  total_stream_time,
  total_view_time,
  chat_message_count,
  points -- calculated from above
}

-- New (CORRECT)
user_stats {
  total_stream_time,     -- for statistics only
  total_view_time,       -- for statistics only
  chat_message_count,    -- for statistics only
  points_balance        -- independent balance
}

-- Add transaction history
points_transactions {
  id,
  user_id,
  amount,           -- positive for earned, negative for spent
  type,             -- 'stream', 'view', 'chat', 'purchase', 'admin', 'bonus'
  description,
  created_at
}
```

### Phase 2: Service Changes

#### A. AccountService.js
**Remove:**
- `calculatePoints()` function
- `calculateAndUpdatePoints()` function

**Add:**
- `addPoints(userId, amount, type, description)`
- `subtractPoints(userId, amount, type, description)`
- `getPointsBalance(userId)`
- `recordTransaction(userId, amount, type, description)`

#### B. TimeTrackingService.js
**Change:**
```javascript
// OLD: Recalculate total
await this.accountService.calculateAndUpdatePoints(userId);

// NEW: Add increment
const pointsToAdd = 200; // for 25 seconds viewing
await this.accountService.addPoints(userId, pointsToAdd, 'view', 'Watching stream');
```

#### C. ShopService.js
**Currently:**
- Can't properly deduct points
- Points would recalculate after purchase

**Fix:**
```javascript
async purchaseItem(userId, itemId) {
  const item = await this.getItem(itemId);
  const balance = await this.accountService.getPointsBalance(userId);
  
  if (balance < item.price) {
    throw new Error('Insufficient points');
  }
  
  // Deduct points
  await this.accountService.subtractPoints(
    userId, 
    item.price, 
    'purchase', 
    `Purchased ${item.name}`
  );
  
  // Add item to inventory
  await this.addToInventory(userId, itemId);
}
```

### Phase 3: Implementation Steps

#### Step 1: Database Migration
1. Add `points_balance` column to user_stats
2. Create points_transactions table
3. Migrate current calculated points to points_balance
4. Keep old points column temporarily for rollback

#### Step 2: Update AccountService
1. Create new points management functions
2. Implement transaction logging
3. Add balance checking methods

#### Step 3: Update Time Tracking
1. Change from recalculation to increments
2. Define point awards:
   - Streaming: +500 per 25 seconds
   - Viewing: +200 per 25 seconds
   - Chat: +50 per message

#### Step 4: Update Shop Service
1. Implement proper point deduction
2. Add purchase validation
3. Create refund capability

#### Step 5: Update UI/Client
1. Display points_balance instead of calculated points
2. Show transaction history
3. Add purchase confirmations

### Phase 4: Services Affected

#### Services that EARN points:
1. **TimeTrackingService** - streaming/viewing time
2. **ChatService** - chat messages
3. **AdminService** - manual awards
4. **BonusService** - daily rewards, achievements

#### Services that SPEND points:
1. **ShopService** - item purchases
2. **BuffService** - temporary buffs
3. **GiftService** - sending gifts to others

#### Services that READ points:
1. **AuthService** - login/profile
2. **LeaderboardService** - rankings
3. **UIService** - display

### Phase 5: Migration Strategy

#### Data Migration Script:
```javascript
// 1. Calculate current points for all users
// 2. Set points_balance = calculated value
// 3. Start logging all future transactions

async function migratePoints() {
  const users = await getAllUsers();
  
  for (const user of users) {
    // Calculate their current points one last time
    const calculatedPoints = calculatePoints(
      user.total_stream_time,
      user.total_view_time,
      user.chat_message_count
    );
    
    // Set as initial balance
    await db.run(
      'UPDATE user_stats SET points_balance = ? WHERE user_id = ?',
      [calculatedPoints, user.id]
    );
    
    // Log initial balance
    await recordTransaction(
      user.id,
      calculatedPoints,
      'migration',
      'Initial balance from activity history'
    );
  }
}
```

### Phase 6: Testing Plan

1. **Test earning points:**
   - Stream for 25 seconds → +500 points
   - View for 25 seconds → +200 points
   - Send chat → +50 points

2. **Test spending points:**
   - Purchase item → -X points
   - Buy buff → -X points
   - Points can't go negative

3. **Test balance persistence:**
   - Points remain after logout/login
   - Points don't recalculate from stats
   - Transaction history is accurate

### Phase 7: Rollback Plan

1. Keep old `points` column temporarily
2. Keep `calculatePoints()` function disabled but not deleted
3. Log all transactions for audit trail
4. Can revert to calculated system if needed

## BENEFITS OF NEW ARCHITECTURE

1. **True Economy**: Points can be earned and spent
2. **Shop Integration**: Purchases actually work
3. **Flexibility**: Can award bonus points, have sales, etc.
4. **Audit Trail**: Complete transaction history
5. **Performance**: No need to recalculate constantly
6. **Features**: Can add gambling, trading, gifts, etc.

## IMPLEMENTATION PRIORITY

1. **Critical** - Database changes and AccountService
2. **High** - TimeTrackingService updates
3. **High** - ShopService integration
4. **Medium** - Transaction history UI
5. **Low** - Admin tools and bonus features

## ESTIMATED TIMELINE

- Database changes: 2 hours
- Service updates: 4 hours
- Testing: 2 hours
- Migration: 1 hour
- **Total: ~9 hours of work**