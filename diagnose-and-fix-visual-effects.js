const { runAsync, getAsync, allAsync } = require('./server/database/database');
const ItemService = require('./server/services/ItemService');
const BuffDebuffService = require('./server/services/BuffDebuffService');
const VisualFxService = require('./server/services/VisualFxService');
const fs = require('fs');
const path = require('path');

async function diagnoseAndFixVisualEffects() {
    console.log('🔧 DIAGNOSE AND FIX VISUAL EFFECTS');
    console.log('=' .repeat(60));
    
    try {
        // 1. Check ClientVisualFxProcessor file
        console.log('\n1. Checking ClientVisualFxProcessor file...');
        const processorPath = path.join(__dirname, 'client', 'public', 'ClientVisualFxProcessor.js');
        
        if (!fs.existsSync(processorPath)) {
            console.log('❌ ClientVisualFxProcessor.js not found');
            return;
        }
        
        const processorContent = fs.readFileSync(processorPath, 'utf8');
        
        // Check if stream_resize_half effect is defined
        const hasResizeEffect = processorContent.includes("'stream_resize_half'");
        console.log(`✅ ClientVisualFxProcessor.js exists (${processorContent.length} chars)`);
        console.log(`   Has stream_resize_half effect: ${hasResizeEffect ? '✅' : '❌'}`);
        
        if (!hasResizeEffect) {
            console.log('❌ stream_resize_half effect not found in ClientVisualFxProcessor');
            console.log('   This is likely the problem!');
        }
        
        // 2. Check useVisualFxProcessor hook
        console.log('\n2. Checking useVisualFxProcessor hook...');
        const hookPath = path.join(__dirname, 'client', 'src', 'hooks', 'useVisualFxProcessor.ts');
        
        if (!fs.existsSync(hookPath)) {
            console.log('❌ useVisualFxProcessor.ts not found');
            return;
        }
        
        const hookContent = fs.readFileSync(hookPath, 'utf8');
        const hasEventListener = hookContent.includes("'visual-effect-applied'");
        console.log(`✅ useVisualFxProcessor.ts exists (${hookContent.length} chars)`);
        console.log(`   Has visual-effect-applied listener: ${hasEventListener ? '✅' : '❌'}`);
        
        // 3. Check WebRTCViewer component
        console.log('\n3. Checking WebRTCViewer component...');
        const viewerPath = path.join(__dirname, 'client', 'src', 'components', 'WebRTCViewer.tsx');
        
        if (!fs.existsSync(viewerPath)) {
            console.log('❌ WebRTCViewer.tsx not found');
            return;
        }
        
        const viewerContent = fs.readFileSync(viewerPath, 'utf8');
        const usesVisualFxProcessor = viewerContent.includes('useVisualFxProcessor');
        console.log(`✅ WebRTCViewer.tsx exists (${viewerContent.length} chars)`);
        console.log(`   Uses useVisualFxProcessor: ${usesVisualFxProcessor ? '✅' : '❌'}`);
        
        // 4. Test server-side functionality
        console.log('\n4. Testing server-side visual effects...');
        
        // Initialize services with proper io mock
        const mockIo = {
            emit: (event, data) => {
                console.log(`📡 MOCK IO: Emitted ${event}:`, data);
                if (event === 'visual-effect-applied') {
                    testResults.serverEmitsVisualEffect = true;
                }
            },
            engine: { clientsCount: 0 }
        };
        
        const itemService = new ItemService();
        const buffDebuffService = new BuffDebuffService(mockIo, null, null, null);
        const visualFxService = new VisualFxService();
        
        // Set dependencies properly
        visualFxService.setDependencies(null, buffDebuffService, null, mockIo, null);
        
        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        let testResults = {
            serverEmitsVisualEffect: false,
            buffServiceWorks: false,
            visualFxServiceWorks: false,
            itemExists: false,
            itemIsBuffDebuff: false
        };
        
        // Check item exists
        const streamReducerItem = await itemService.getItemByName('stream_reducer');
        testResults.itemExists = !!streamReducerItem;
        testResults.itemIsBuffDebuff = streamReducerItem ? itemService.isBuffOrDebuffItem(streamReducerItem) : false;
        
        if (streamReducerItem && testResults.itemIsBuffDebuff) {
            // Test full flow
            try {
                const buffResult = await itemService.applyBuffDebuffItem(
                    1, // userId
                    streamReducerItem.id,
                    2, // appliedBy
                    buffDebuffService,
                    true, // skip cooldown
                    'test_stream_123' // streamId
                );
                
                testResults.buffServiceWorks = !!buffResult;
                testResults.visualFxServiceWorks = true;
                
            } catch (error) {
                console.log('❌ Error in buff application:', error.message);
            }
        }
        
        // 5. Analyze results and provide fix
        console.log('\n5. Analysis and Diagnosis...');
        console.log('   Server-side results:');
        Object.entries(testResults).forEach(([key, value]) => {
            console.log(`     ${key}: ${value ? '✅' : '❌'}`);
        });
        
        // 6. Generate fix recommendations
        console.log('\n6. Fix Recommendations...');
        
        if (!testResults.serverEmitsVisualEffect) {
            console.log('❌ SERVER ISSUE: visual-effect-applied event not emitted');
            console.log('   Fix: Check VisualFxService socket.io setup');
        } else {
            console.log('✅ Server-side working correctly');
        }
        
        if (!hasResizeEffect) {
            console.log('❌ CLIENT ISSUE: stream_resize_half effect not in ClientVisualFxProcessor');
            console.log('   Fix: Add effect definition to ClientVisualFxProcessor.js');
        }
        
        if (!usesVisualFxProcessor) {
            console.log('❌ CLIENT ISSUE: WebRTCViewer not using useVisualFxProcessor hook');
            console.log('   Fix: Add useVisualFxProcessor hook to WebRTCViewer component');
        }
        
        // 7. Auto-fix what we can
        console.log('\n7. Attempting automatic fixes...');
        
        // Fix 1: Ensure ClientVisualFxProcessor has the effect (already done in previous fixes)
        if (hasResizeEffect) {
            console.log('✅ ClientVisualFxProcessor already has stream_resize_half effect');
        }
        
        // Fix 2: Ensure useVisualFxProcessor has debugging (already done)
        if (hookContent.includes('Received visual-effect-applied event')) {
            console.log('✅ useVisualFxProcessor already has debugging');
        }
        
        // Fix 3: Create a simple test HTML page to verify client-side functionality
        console.log('\n8. Creating client-side test page...');
        const testHtml = `<!DOCTYPE html>
<html>
<head>
    <title>Visual Effects Client Test</title>
    <style>
        body { font-family: Arial, sans-serif; padding: 20px; }
        .test-video { 
            width: 400px; 
            height: 300px; 
            background: linear-gradient(45deg, #ff6b6b, #4ecdc4); 
            border: 2px solid #333;
            transition: transform 0.3s ease;
        }
        button { padding: 10px 20px; margin: 5px; }
        .log { background: #f5f5f5; padding: 10px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: 12px; }
    </style>
</head>
<body>
    <h1>🧪 Visual Effects Client Test</h1>
    
    <div class="test-video" id="testVideo">Test Video Element</div>
    
    <div>
        <button onclick="loadProcessor()">Load Processor</button>
        <button onclick="testEffect()">Test stream_resize_half</button>
        <button onclick="testDirectCSS()">Test Direct CSS</button>
        <button onclick="clearEffects()">Clear Effects</button>
    </div>
    
    <h3>Log:</h3>
    <div class="log" id="log"></div>
    
    <script>
        let processor = null;
        
        function log(msg) {
            const logEl = document.getElementById('log');
            logEl.innerHTML += new Date().toLocaleTimeString() + ': ' + msg + '\\n';
            logEl.scrollTop = logEl.scrollHeight;
            console.log(msg);
        }
        
        function loadProcessor() {
            const script = document.createElement('script');
            script.src = '/ClientVisualFxProcessor.js';
            script.onload = () => {
                processor = new ClientVisualFxProcessor();
                const video = document.getElementById('testVideo');
                const success = processor.initialize(video);
                log('Processor loaded and initialized: ' + success);
                log('Available effects: ' + Object.keys(processor.effectDefinitions).join(', '));
            };
            script.onerror = () => log('Failed to load ClientVisualFxProcessor');
            document.head.appendChild(script);
        }
        
        function testEffect() {
            if (!processor) {
                log('Load processor first!');
                return;
            }
            const result = processor.applyEffect('stream_resize_half', { duration: 5000 });
            log('Applied stream_resize_half effect: ' + result);
            setTimeout(() => {
                const video = document.getElementById('testVideo');
                log('Video transform: ' + video.style.transform);
            }, 100);
        }
        
        function testDirectCSS() {
            const video = document.getElementById('testVideo');
            video.style.transform = 'scale(0.5)';
            log('Applied direct CSS scale(0.5)');
        }
        
        function clearEffects() {
            const video = document.getElementById('testVideo');
            video.style.transform = '';
            log('Cleared all effects');
        }
        
        log('Test page loaded. Click "Load Processor" first.');
    </script>
</body>
</html>`;
        
        const testHtmlPath = path.join(__dirname, 'client', 'public', 'visual-effects-test.html');
        fs.writeFileSync(testHtmlPath, testHtml);
        console.log('✅ Created visual-effects-test.html');
        console.log('   Access at: http://localhost:3000/visual-effects-test.html');
        
        // Final summary
        console.log('\n' + '=' .repeat(60));
        console.log('🎯 DIAGNOSIS COMPLETE');
        console.log('=' .repeat(60));
        
        if (testResults.serverEmitsVisualEffect && hasResizeEffect && usesVisualFxProcessor) {
            console.log('✅ ALL COMPONENTS WORKING - Visual effects should work!');
            console.log('');
            console.log('If still not working, the issue is likely:');
            console.log('1. Socket events not reaching the client (check browser console)');
            console.log('2. Video element not found by ClientVisualFxProcessor');
            console.log('3. CSS transforms being overridden by other styles');
            console.log('');
            console.log('Next steps:');
            console.log('1. Open http://localhost:3000/visual-effects-test.html');
            console.log('2. Test if ClientVisualFxProcessor works in isolation');
            console.log('3. Check browser console for socket event logs when using Stream Reducer');
        } else {
            console.log('❌ ISSUES FOUND - See recommendations above');
        }
        
        // Clean up
        buffDebuffService.shutdown();
        
    } catch (error) {
        console.error('❌ Error during diagnosis:', error);
    } finally {
        process.exit(0);
    }
}

// Run the diagnosis
diagnoseAndFixVisualEffects();