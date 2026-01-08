const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Test the recording system
async function testRecordingSystem() {
  console.log('🧪 Testing Recording System Implementation...\n');
  
  let passed = 0;
  let failed = 0;
  
  const test = (name, condition, message) => {
    if (condition) {
      console.log(`✅ ${name}: ${message || 'PASS'}`);
      passed++;
    } else {
      console.log(`❌ ${name}: ${message || 'FAIL'}`);
      failed++;
    }
  };
  
  // Test 1: Check if recording services exist
  try {
    const RecordingService = require('./server/services/RecordingService');
    const FileCompressionService = require('./server/services/FileCompressionService');
    const RecordingStorageService = require('./server/services/RecordingStorageService');
    
    test('Service Files', true, 'All recording service files exist');
  } catch (error) {
    test('Service Files', false, `Missing service files: ${error.message}`);
  }
  
  // Test 2: Check database schema
  try {
    const schemaPath = path.join(__dirname, 'server/database/recording-schema.sql');
    const schemaExists = fs.existsSync(schemaPath);
    test('Database Schema', schemaExists, 'Schema file exists');
    
    if (schemaExists) {
      const schemaContent = fs.readFileSync(schemaPath, 'utf8');
      const hasRecordingsTable = schemaContent.includes('CREATE TABLE IF NOT EXISTS recordings');
      const hasEventsTable = schemaContent.includes('CREATE TABLE IF NOT EXISTS recording_events');
      const hasSettingsTable = schemaContent.includes('CREATE TABLE IF NOT EXISTS recording_settings');
      
      test('Recordings Table', hasRecordingsTable, 'Recordings table definition found');
      test('Events Table', hasEventsTable, 'Events table definition found');
      test('Settings Table', hasSettingsTable, 'Settings table definition found');
    }
  } catch (error) {
    test('Database Schema', false, `Schema check failed: ${error.message}`);
  }
  
  // Test 3: Check migration script
  try {
    const migrationPath = path.join(__dirname, 'server/migrations/setup-recording-tables.js');
    const migrationExists = fs.existsSync(migrationPath);
    test('Migration Script', migrationExists, 'Migration script exists');
  } catch (error) {
    test('Migration Script', false, `Migration check failed: ${error.message}`);
  }
  
  // Test 4: Check directory structure
  const directories = [
    'recordings/active',
    'recordings/processing',
    'recordings/completed',
    'recordings/archived',
    'recordings/thumbnails',
    'recordings/metadata',
    'recordings/temp',
    'recordings/backups'
  ];
  
  let directoriesOk = 0;
  directories.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (fs.existsSync(dirPath)) {
      directoriesOk++;
    }
  });
  
  test('Directory Structure', directoriesOk === directories.length, 
    `${directoriesOk}/${directories.length} directories created`);
  
  // Test 5: Check React component
  try {
    const componentPath = path.join(__dirname, 'client/src/components/RecordingManagement.tsx');
    const componentExists = fs.existsSync(componentPath);
    test('React Component', componentExists, 'RecordingManagement component exists');
    
    if (componentExists) {
      const componentContent = fs.readFileSync(componentPath, 'utf8');
      const hasRecordingInterface = componentContent.includes('interface Recording');
      const hasApiCalls = componentContent.includes('makeApiCall');
      
      test('Component Structure', hasRecordingInterface && hasApiCalls, 
        'Component has proper TypeScript interfaces and API integration');
    }
  } catch (error) {
    test('React Component', false, `Component check failed: ${error.message}`);
  }
  
  // Test 6: Check CSS styles
  try {
    const cssPath = path.join(__dirname, 'client/src/components/RecordingManagement.css');
    const cssExists = fs.existsSync(cssPath);
    test('CSS Styles', cssExists, 'RecordingManagement CSS exists');
  } catch (error) {
    test('CSS Styles', false, `CSS check failed: ${error.message}`);
  }
  
  // Test 7: Check AdminPanel integration
  try {
    const adminPanelPath = path.join(__dirname, 'client/src/components/AdminPanel.tsx');
    if (fs.existsSync(adminPanelPath)) {
      const adminContent = fs.readFileSync(adminPanelPath, 'utf8');
      const hasRecordingImport = adminContent.includes('import RecordingManagement');
      const hasRecordingTab = adminContent.includes("'recordings'");
      const hasRecordingComponent = adminContent.includes('<RecordingManagement');
      
      test('Admin Panel Integration', hasRecordingImport && hasRecordingTab && hasRecordingComponent, 
        'Recording management properly integrated into admin panel');
    } else {
      test('Admin Panel Integration', false, 'AdminPanel.tsx not found');
    }
  } catch (error) {
    test('Admin Panel Integration', false, `Admin panel check failed: ${error.message}`);
  }
  
  // Test 8: Check server integration
  try {
    const serverPath = path.join(__dirname, 'server/index.js');
    if (fs.existsSync(serverPath)) {
      const serverContent = fs.readFileSync(serverPath, 'utf8');
      const hasRecordingImports = serverContent.includes('require(\'./services/RecordingService\')');
      const hasRecordingEndpoints = serverContent.includes('/admin/recordings/');
      const hasRecordingInit = serverContent.includes('Recording system initialized');
      
      test('Server Integration', hasRecordingImports && hasRecordingEndpoints, 
        'Recording services and endpoints integrated into server');
      test('Recording Initialization', hasRecordingInit, 
        'Recording system initialization code present');
    } else {
      test('Server Integration', false, 'server/index.js not found');
    }
  } catch (error) {
    test('Server Integration', false, `Server integration check failed: ${error.message}`);
  }
  
  // Test 9: Check dependencies
  try {
    const packagePath = path.join(__dirname, 'package.json');
    if (fs.existsSync(packagePath)) {
      const packageContent = fs.readFileSync(packagePath, 'utf8');
      const packageData = JSON.parse(packageContent);
      
      const requiredDeps = ['fluent-ffmpeg', 'uuid', 'mediasoup'];
      let depsOk = 0;
      
      requiredDeps.forEach(dep => {
        if (packageData.dependencies && packageData.dependencies[dep]) {
          depsOk++;
        }
      });
      
      test('Dependencies', depsOk === requiredDeps.length, 
        `${depsOk}/${requiredDeps.length} required dependencies found`);
    } else {
      test('Dependencies', false, 'package.json not found');
    }
  } catch (error) {
    test('Dependencies', false, `Dependencies check failed: ${error.message}`);
  }
  
  // Test 10: Syntax check for main files
  const filesToCheck = [
    'server/services/RecordingService.js',
    'server/services/FileCompressionService.js',
    'server/services/RecordingStorageService.js'
  ];
  
  let syntaxOk = 0;
  filesToCheck.forEach(file => {
    try {
      const filePath = path.join(__dirname, file);
      if (fs.existsSync(filePath)) {
        // Basic syntax check - try to parse as module
        require(filePath);
        syntaxOk++;
      }
    } catch (error) {
      console.log(`⚠️ Syntax issue in ${file}: ${error.message}`);
    }
  });
  
  test('Syntax Check', syntaxOk === filesToCheck.length, 
    `${syntaxOk}/${filesToCheck.length} files have valid syntax`);
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`📊 Test Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));
  
  if (failed === 0) {
    console.log('🎉 All tests passed! Recording system is ready for testing.');
    console.log('\n📋 Next Steps:');
    console.log('1. Start the server: npm run dev');
    console.log('2. Open admin panel: Ctrl+Shift+A');
    console.log('3. Navigate to "📹 Recordings" tab');
    console.log('4. Test recording functionality with active stream');
  } else {
    console.log('❌ Some tests failed. Please review and fix issues before testing.');
  }
  
  return failed === 0;
}

// Run tests
testRecordingSystem().catch(console.error);