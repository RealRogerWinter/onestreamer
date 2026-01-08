// Test script to simulate real-time points updates
const io = require('socket.io-client');

const socket = io('http://localhost:3001');

let testUserId = null;
let pointsValue = 1000;

socket.on('connect', () => {
    console.log('✅ Connected to server');
    console.log('Socket ID:', socket.id);
    
    // Start sending test updates
    startTestUpdates();
});

socket.on('disconnect', () => {
    console.log('❌ Disconnected from server');
});

function startTestUpdates() {
    console.log('\n🎯 Starting points update tests...\n');
    
    // Test 1: Single update
    setTimeout(() => {
        pointsValue += 100;
        console.log(`📤 Emitting time-stats-update with points: ${pointsValue}`);
        socket.emit('time-stats-update', {
            userId: testUserId,
            points: pointsValue,
            updateType: 'test',
            timestamp: Date.now()
        });
    }, 1000);
    
    // Test 2: Rapid updates
    setTimeout(() => {
        console.log('\n📤 Starting rapid updates test...');
        let rapidPoints = pointsValue;
        const interval = setInterval(() => {
            rapidPoints += 50;
            console.log(`📤 Rapid update: ${rapidPoints}`);
            socket.emit('time-stats-update', {
                userId: testUserId,
                points: rapidPoints,
                updateType: 'rapid-test',
                timestamp: Date.now()
            });
        }, 200);
        
        setTimeout(() => {
            clearInterval(interval);
            pointsValue = rapidPoints;
            console.log('✅ Rapid updates complete');
        }, 2000);
    }, 3000);
    
    // Test 3: Large jump
    setTimeout(() => {
        pointsValue += 1000;
        console.log(`\n📤 Large jump to: ${pointsValue}`);
        socket.emit('points-updated', {
            points: pointsValue
        });
    }, 6000);
    
    // Test 4: Decrease
    setTimeout(() => {
        pointsValue -= 500;
        console.log(`\n📤 Decreasing to: ${pointsValue}`);
        socket.emit('points-updated', {
            points: pointsValue
        });
    }, 8000);
}

// Listen for any responses
socket.on('time-stats-update', (data) => {
    console.log('📥 Received time-stats-update:', data);
});

socket.on('points-updated', (data) => {
    console.log('📥 Received points-updated:', data);
});

console.log('🚀 Points update test client started');
console.log('📝 This will simulate various points update scenarios');
console.log('⏰ Tests will run for about 10 seconds\n');

// Keep the script running
setTimeout(() => {
    console.log('\n✅ All tests complete');
    process.exit(0);
}, 12000);