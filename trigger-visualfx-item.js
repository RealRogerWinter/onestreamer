const io = require('socket.io-client');
const readline = require('readline');

const SERVER_URL = 'http://localhost:8080';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function main() {
    console.log('🎨 Visual Effects Item Trigger Test');
    console.log('====================================\n');
    
    // Connect to server
    const socket = io(SERVER_URL, {
        transports: ['websocket'],
        reconnection: true
    });
    
    await new Promise((resolve) => {
        socket.on('connect', () => {
            console.log(`✅ Connected to server with socket ID: ${socket.id}\n`);
            resolve();
        });
    });
    
    // Listen for visual effect events
    socket.on('visual-effect-applied', (data) => {
        console.log('🎬 VISUAL EFFECT APPLIED:', JSON.stringify(data, null, 2));
    });
    
    socket.on('visual-effect-removed', (data) => {
        console.log('🎬 VISUAL EFFECT REMOVED:', JSON.stringify(data, null, 2));
    });
    
    socket.on('buff-applied', (data) => {
        console.log('🎭 BUFF APPLIED:', {
            itemName: data.itemName,
            displayName: data.displayName,
            userId: data.userId,
            remainingSeconds: data.remainingSeconds
        });
    });
    
    // Available visual effect items
    const visualEffectItems = [
        { name: 'emboss', display: '🎨 Emboss - 3D relief effect' },
        { name: 'pixelate', display: '🟦 Pixelate - Heavy pixelation' },
        { name: 'motion_blur', display: '💨 Motion Blur - Blur effect' },
        { name: 'glitch_bomb', display: '⚡ Glitch Bomb - Digital glitch' },
        { name: 'thermal_vision', display: '🔥 Thermal Vision - Heat map' },
        { name: 'rotate_90', display: '🔄 Rotate 90° - Rotate video' },
        { name: 'potato', display: '🥔 Potato - Ultra low quality' }
    ];
    
    console.log('Available Visual Effect Items:');
    visualEffectItems.forEach((item, index) => {
        console.log(`  ${index + 1}. ${item.display}`);
    });
    
    const answer = await new Promise((resolve) => {
        rl.question('\nEnter item number to trigger (1-7): ', resolve);
    });
    
    const itemIndex = parseInt(answer) - 1;
    if (itemIndex < 0 || itemIndex >= visualEffectItems.length) {
        console.log('❌ Invalid selection');
        socket.disconnect();
        rl.close();
        return;
    }
    
    const selectedItem = visualEffectItems[itemIndex];
    console.log(`\n🎯 Triggering: ${selectedItem.display}\n`);
    
    // Use the item (this will trigger the buff/debuff and subsequently the visual effect)
    socket.emit('use-item', {
        itemName: selectedItem.name,
        targetUserId: 1, // Use on user ID 1 (or current user)
        message: 'Testing visual effect'
    }, (response) => {
        if (response.success) {
            console.log('✅ Item used successfully!');
            console.log('   Waiting for visual effect to trigger...\n');
        } else {
            console.log('❌ Failed to use item:', response.error);
        }
    });
    
    // Wait a bit to see the effects
    setTimeout(() => {
        console.log('\n📊 Test complete. Check the logs above for visual effect events.');
        console.log('The visual effect should be active on any active streams.\n');
        
        rl.question('Press Enter to exit...', () => {
            socket.disconnect();
            rl.close();
            process.exit(0);
        });
    }, 5000);
}

main().catch(console.error);