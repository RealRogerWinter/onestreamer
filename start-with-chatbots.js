const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting OneStreamer with ChatBot Service...\n');

// Check if Ollama is running
const checkOllama = spawn('curl', ['-s', 'http://localhost:11434/api/tags'], { shell: true });

checkOllama.on('close', (code) => {
    if (code !== 0) {
        console.log('⚠️  Ollama is not running. ChatBots will use fallback responses.');
        console.log('   To enable AI responses:');
        console.log('   1. Install Ollama from https://ollama.ai');
        console.log('   2. Run: ollama serve');
        console.log('   3. Pull a model: ollama pull mistral\n');
    } else {
        console.log('✅ Ollama is running. ChatBots will use AI responses.\n');
    }
    
    // Start the chat service
    console.log('Starting Chat Service on port 8081...');
    const chatService = spawn('node', ['index.js'], {
        cwd: path.join(__dirname, 'chat-service'),
        stdio: 'inherit'
    });
    
    // Give chat service time to start
    setTimeout(() => {
        // Start the main server
        console.log('\nStarting Main Server on port 8080...');
        const mainServer = spawn('node', ['index.js'], {
            cwd: path.join(__dirname, 'server'),
            stdio: 'inherit'
        });
        
        // Give server time to start
        setTimeout(() => {
            // Start the client
            console.log('\nStarting Client on port 3000...');
            const client = spawn('npm', ['start'], {
                cwd: path.join(__dirname, 'client'),
                stdio: 'inherit',
                shell: true
            });
            
            console.log('\n✨ All services started!');
            console.log('   Main app: http://localhost:3000');
            console.log('   Admin panel: http://localhost:3000 (click Admin button)');
            console.log('   ChatBot management: Admin Panel > ChatBots tab\n');
            console.log('📝 To create and manage chatbots:');
            console.log('   1. Open the Admin Panel');
            console.log('   2. Go to the ChatBots tab');
            console.log('   3. Create new bots with custom personalities');
            console.log('   4. Enable/disable bots as needed');
            console.log('   5. Test bot responses before enabling\n');
            
            // Handle graceful shutdown
            process.on('SIGINT', () => {
                console.log('\n🛑 Shutting down services...');
                client.kill();
                mainServer.kill();
                chatService.kill();
                process.exit(0);
            });
            
        }, 3000);
    }, 2000);
});