const axios = require('axios');

async function checkServices() {
    console.log('🔍 Checking OneStreamer Services Status...\n');
    
    const services = [
        { name: 'Main Server', url: 'http://localhost:8080', type: 'server' },
        { name: 'Chat Service', url: 'http://localhost:8081/health', type: 'health' },
        { name: 'Client App', url: 'http://localhost:3000', type: 'client' },
        { name: 'Ollama LLM', url: 'http://localhost:11434/api/tags', type: 'api' }
    ];
    
    for (const service of services) {
        try {
            const response = await axios.get(service.url, { timeout: 2000 });
            console.log(`✅ ${service.name}: RUNNING`);
            
            if (service.type === 'health' && response.data) {
                console.log(`   Connected users: ${response.data.connectedUsers || 0}`);
                console.log(`   Messages: ${response.data.messagesInHistory || 0}`);
            }
            
            if (service.name === 'Ollama LLM' && response.data?.models) {
                console.log(`   Models: ${response.data.models.map(m => m.name).join(', ')}`);
            }
        } catch (error) {
            console.log(`❌ ${service.name}: NOT RUNNING`);
            
            if (service.name === 'Main Server') {
                console.log('   Run: cd server && node index.js');
            } else if (service.name === 'Chat Service') {
                console.log('   Run: cd chat-service && node index.js');
            } else if (service.name === 'Client App') {
                console.log('   Run: cd client && npm start');
            } else if (service.name === 'Ollama LLM') {
                console.log('   Run: ollama serve (optional for AI responses)');
            }
        }
    }
    
    console.log('\n📝 Quick Start Commands:');
    console.log('   All services: node start-with-chatbots.js');
    console.log('   Main server only: cd server && node index.js');
    console.log('   Chat service only: cd chat-service && node index.js');
}

checkServices();