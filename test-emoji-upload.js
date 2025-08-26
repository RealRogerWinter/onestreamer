const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

async function testAvifConversion() {
    console.log('Testing AVIF conversion for Safari compatibility...\n');
    
    // Test with a sample PNG file
    const testDir = '/tmp/emoji-test';
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }
    
    // Create a simple test image using ImageMagick
    const pngPath = path.join(testDir, 'test.png');
    console.log('Creating test PNG image...');
    await execPromise(`convert -size 64x64 xc:red -draw "circle 32,32 32,10" ${pngPath}`);
    
    if (!fs.existsSync(pngPath)) {
        console.error('Failed to create test PNG');
        return;
    }
    console.log('✓ Test PNG created:', pngPath);
    
    // Convert to AVIF with Safari-compatible settings
    const avifPath = path.join(testDir, 'test.avif');
    console.log('\nConverting to Safari-compatible AVIF...');
    
    try {
        const cmd = `avifenc --qcolor 85 --speed 6 --yuv 420 --range limited --cicp 1/13/6 --autotiling --jobs all "${pngPath}" "${avifPath}"`;
        console.log('Command:', cmd);
        
        const { stdout, stderr } = await execPromise(cmd);
        if (stdout) console.log('Output:', stdout);
        if (stderr) console.log('Warnings:', stderr);
        
        if (fs.existsSync(avifPath) && fs.statSync(avifPath).size > 0) {
            console.log('✓ AVIF file created successfully:', avifPath);
            console.log('  Size:', fs.statSync(avifPath).size, 'bytes');
            
            // Check the encoding parameters
            console.log('\nChecking AVIF encoding parameters...');
            const { stdout: probeOutput } = await execPromise(`ffprobe -v error -show_streams "${avifPath}" 2>/dev/null | grep -E "codec_name|color_"`);
            console.log('Encoding info:\n', probeOutput);
        } else {
            console.error('✗ AVIF conversion failed');
        }
    } catch (error) {
        console.error('Error during conversion:', error.message);
    }
    
    // Clean up
    console.log('\nCleaning up test files...');
    if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
    if (fs.existsSync(avifPath)) fs.unlinkSync(avifPath);
    console.log('✓ Test complete');
}

testAvifConversion().catch(console.error);