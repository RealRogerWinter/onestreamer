const { spawn, exec } = require('child_process');
const path = require('path');
const axios = require('axios');

console.log('🔄 Restarting OneStreamer Services...\n');

// Kill existing processes
console.log('🛑 Stopping existing services...');

// Kill Node processes on specific ports
const killCommands = [
    'taskkill /F /FI "WINDOWTITLE eq *8080*" 2>nul',
    'taskkill /F /FI "WINDOWTITLE eq *8081*" 2>nul', 
    'taskkill /F /FI "WINDOWTITLE eq *3000*" 2>nul',
    'netstat -ano | findstr :8080 | findstr LISTENING',
    'netstat -ano | findstr :8081 | findstr LISTENING',
    'netstat -ano | findstr :3000 | findstr LISTENING'
];

let killCount = 0;
killCommands.forEach(cmd => {
    exec(cmd, (error, stdout) => {
        killCount++;
        if (killCount === killCommands.length) {
            // All kill commands done, wait then start services
            setTimeout(startServices, 2000);
        }
    });
});

function startServices() {
    console.log('\n🚀 Starting OneStreamer with ChatBot Service...\n');
    
    // Check if Ollama is running
    axios.get('http://localhost:11434/api/tags', { timeout: 1000 })
        .then(() => {
            console.log('✅ Ollama is running. ChatBots will use AI responses.\n');
        })
        .catch(() => {
            console.log('⚠️  Ollama is not running. ChatBots will use fallback responses.');
            console.log('   To enable AI responses:');
            console.log('   1. Install Ollama from https://ollama.ai');
            console.log('   2. Run: ollama serve');
            console.log('   3. Pull a model: ollama pull mistral\n');
        })
        .finally(() => {
            launchServices();
        });
}

function launchServices() {
    // Start the chat service first
    console.log('💬 Starting Chat Service on port 8081...');
    const chatService = spawn('node', ['index.js'], {
        cwd: path.join(__dirname, 'chat-service'),
        stdio: 'inherit',
        shell: true
    });
    
    chatService.on('error', (err) => {
        console.error('Chat service error:', err);
    });
    
    // Give chat service time to start
    setTimeout(() => {
        // Start the main server (includes ChatBot service)
        console.log('\n📡 Starting Main Server with ChatBot Service on port 8080...');
        const mainServer = spawn('node', ['index.js'], {
            cwd: path.join(__dirname, 'server'),
            stdio: 'inherit',
            shell: true
        });
        
        mainServer.on('error', (err) => {
            console.error('Main server error:', err);
        });
        
        // Give server time to start
        setTimeout(() => {
            // Start the client
            console.log('\n🌐 Starting React Client on port 3000...');
            const client = spawn('npm', ['start'], {
                cwd: path.join(__dirname, 'client'),
                stdio: 'inherit',
                shell: true,
                env: { ...process.env, BROWSER: 'none' } // Don't auto-open browser
            });
            
            client.on('error', (err) => {
                console.error('Client error:', err);
            });
            
            setTimeout(() => {
                console.log('\n✨ All services started successfully!\n');
                console.log('📌 Access Points:');
                console.log('   Main app: http://localhost:3000');
                console.log('   Admin panel: http://localhost:3000 (click Admin button)');
                console.log('   ChatBot management: Admin Panel > ChatBots tab\n');
                console.log('🤖 ChatBot Features:');
                console.log('   • Create multiple bots with unique personalities');
                console.log('   • Enable/disable bots individually');
                console.log('   • Send manual messages for testing');
                console.log('   • Automatic responses at random intervals');
                console.log('   • Fallback responses when Ollama is offline\n');
                console.log('Press Ctrl+C to stop all services\n');
            }, 5000);
            
            // Handle graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down all services...');
                try {
                    client.kill();
                    mainServer.kill();
                    chatService.kill();
                } catch (e) {
                    // Ignore errors during shutdown
                }
                setTimeout(() => process.exit(0), 1000);
            });
            
        }, 3000);
    }, 3000);
}