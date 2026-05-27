const AccountService = require('./AccountService');

const logger = require('../bootstrap/logger').child({ svc: 'AccountDeletionScheduler' });
class AccountDeletionScheduler {
    constructor() {
        // Delay creating AccountService to ensure database is ready
        this.accountService = null;
        this.intervalId = null;
        this.checkInterval = 60 * 60 * 1000; // Check every hour
    }
    
    initAccountService() {
        if (!this.accountService) {
            this.accountService = new AccountService();
        }
    }

    start() {
        logger.debug('🗑️ DELETION SCHEDULER: Starting account deletion scheduler');
        
        // Initialize AccountService
        this.initAccountService();
        
        // Run immediately on start
        this.checkAndDeleteAccounts();
        
        // Then run every hour
        this.intervalId = setInterval(() => {
            this.checkAndDeleteAccounts();
        }, this.checkInterval);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            logger.debug('🗑️ DELETION SCHEDULER: Stopped account deletion scheduler');
        }
    }

    async checkAndDeleteAccounts() {
        try {
            logger.debug('🗑️ DELETION SCHEDULER: Checking for accounts pending deletion...');
            
            // Ensure AccountService is initialized
            this.initAccountService();
            
            const accountsPendingDeletion = await this.accountService.getAccountsPendingDeletion();
            
            if (accountsPendingDeletion.length === 0) {
                logger.debug('🗑️ DELETION SCHEDULER: No accounts ready for permanent deletion');
                return;
            }

            logger.debug(`🗑️ DELETION SCHEDULER: Found ${accountsPendingDeletion.length} accounts ready for permanent deletion`);

            for (const account of accountsPendingDeletion) {
                try {
                    logger.debug(`🗑️ DELETION SCHEDULER: Permanently deleting account: ${account.username} (ID: ${account.id})`);
                    
                    await this.accountService.permanentlyDeleteAccount(account.id);
                    
                    logger.debug(`🗑️ DELETION SCHEDULER: Successfully deleted account: ${account.username} (ID: ${account.id})`);
                } catch (error) {
                    logger.error(`🗑️ DELETION SCHEDULER: Failed to delete account ${account.id}:`, error);
                }
            }
        } catch (error) {
            logger.error('🗑️ DELETION SCHEDULER: Error checking for accounts to delete:', error);
        }
    }
}

module.exports = AccountDeletionScheduler;
