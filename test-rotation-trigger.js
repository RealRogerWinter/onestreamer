// Test if rotation trigger works
console.log('Testing rotation trigger...');
console.log('global.viewBotRotation exists:', !!global.viewBotRotation);
console.log('global.viewBotRotation.enabled:', global.viewBotRotation?.enabled);

if (global.viewBotRotation && global.viewBotRotation.enabled) {
  console.log('✅ Rotation is enabled, testing trigger...');

  setTimeout(async () => {
    console.log('⏰ 5 second delay passed, calling rotateToNextBot...');
    try {
      await global.viewBotRotation.rotateToNextBot();
      console.log('✅ Rotation triggered successfully!');
    } catch (error) {
      console.error('❌ Rotation failed:', error);
    }
  }, 5000);
} else {
  console.log('❌ Rotation is NOT enabled');
  console.log('   - exists:', !!global.viewBotRotation);
  console.log('   - enabled:', global.viewBotRotation?.enabled);
}
