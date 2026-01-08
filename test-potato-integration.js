const io = require('socket.io-client');
const axios = require('axios');

const API_URL = 'http://localhost:8080';
let authToken = null;
let currentUserId = null;

async function login() {
    try {
        const response = await axios.post(`${API_URL}/api/auth/login`, {
            email: 'admin@example.com',
            password: 'REDACTED-ADMIN-KEY'
        });
        authToken = response.data.token;
        currentUserId = response.data.user.id;
        console.log('✅ Logged in successfully');
        return true;
    } catch (error) {
        console.error('❌ Login failed:', error.response?.data || error.message);
        return false;
    }
}

async function getCurrentStreamer() {
    try {
        const response = await axios.get(`${API_URL}/api/stream/current-streamer`);
        return response.data;
    } catch (error) {
        console.error('❌ Failed to get current streamer:', error.response?.data || error.message);
        return null;
    }
}

async function applyPotatoToStreamer() {
    try {
        // Get current streamer
        const streamerData = await getCurrentStreamer();
        if (!streamerData || !streamerData.streamerId) {
            console.log('⚠️ No active streamer found');
            return;
        }
        
        console.log('🎯 Current streamer:', streamerData);
        
        // Get potato item ID
        const itemsResponse = await axios.get(`${API_URL}/api/items`, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        
        const potatoItem = itemsResponse.data.items.find(item => item.name === 'potato');
        if (!potatoItem) {
            console.error('❌ Potato item not found');
            return;
        }
        
        console.log('🥔 Found Potato item:', potatoItem);
        
        // Apply the potato buff to the streamer
        const buffResponse = await axios.post(`${API_URL}/api/buffs/apply`, {
            targetUserId: streamerData.userId || streamerData.streamerId,
            itemId: potatoItem.id
        }, {
            headers: { Authorization: `Bearer ${authToken}` }
        });
        
        console.log('✅ Potato applied successfully:', buffResponse.data);
        return buffResponse.data;
    } catch (error) {
        console.error('❌ Failed to apply Potato:', error.response?.data || error.message);
    }
}

async function main() {
    console.log('🥔 Testing Potato Item Integration');
    console.log('=====================================\n');
    
    // Login first
    const loginSuccess = await login();
    if (!loginSuccess) {
        console.error('Cannot proceed without login');
        process.exit(1);
    }
    
    // Connect to socket for real-time updates
    const socket = io(API_URL, {
        auth: { token: authToken }
    });
    
    socket.on('connect', () => {
        console.log('✅ Connected to socket server');
    });
    
    // Listen for visual effect events
    socket.on('visual-effect-applied', (data) => {
        console.log('🎨 Visual effect applied:', data);
    });
    
    socket.on('visual-effect-removed', (data) => {
        console.log('🎨 Visual effect removed:', data);
    });
    
    socket.on('buff-applied', (data) => {
        console.log('💫 Buff applied:', data);
    });
    
    socket.on('buff-expired', (data) => {
        console.log('💫 Buff expired:', data);
    });
    
    // Wait for socket connection
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Apply potato to current streamer
    console.log('\n🥔 Applying Potato to current streamer...');
    await applyPotatoToStreamer();
    
    // Keep script running to observe events
    console.log('\n📡 Listening for events (press Ctrl+C to exit)...');
}

main().catch(console.error);