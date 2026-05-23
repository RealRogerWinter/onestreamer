#!/usr/bin/env node

const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const EMOJI_DIR = path.join(__dirname, '..', '..', 'server', 'uploads', 'emojis');

// Function to convert a single emoji to multiple formats
async function convertEmoji(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, ext);
  const dirName = path.dirname(filePath);
  
  if (ext !== '.avif') {
    return; // Skip non-AVIF files
  }
  
  try {
    console.log(`Converting ${baseName}...`);
    
    // Read the AVIF file
    const buffer = await fs.readFile(filePath);
    const image = sharp(buffer);
    
    // Create WebP version (better compatibility than AVIF, smaller than PNG)
    const webpPath = path.join(dirName, `${baseName}.webp`);
    await image
      .webp({ quality: 90, effort: 6 })
      .toFile(webpPath);
    console.log(`  ✓ Created WebP: ${baseName}.webp`);
    
    // Create PNG version (universal fallback)
    const pngPath = path.join(dirName, `${baseName}.png`);
    await image
      .png({ compressionLevel: 9 })
      .toFile(pngPath);
    console.log(`  ✓ Created PNG: ${baseName}.png`);
    
    // Re-encode AVIF with Safari-compatible settings
    // Using specific encoding parameters that work better with Safari
    const avifPath = path.join(dirName, `${baseName}_reencoded.avif`);
    await image
      .avif({
        quality: 85,
        effort: 4,
        chromaSubsampling: '4:4:4' // Disable chroma subsampling for better compatibility
      })
      .toFile(avifPath);
    console.log(`  ✓ Re-encoded AVIF: ${baseName}_reencoded.avif`);
    
    // Replace original AVIF with re-encoded version
    await fs.unlink(filePath);
    await fs.rename(avifPath, filePath);
    console.log(`  ✓ Replaced original AVIF with re-encoded version`);
    
  } catch (error) {
    console.error(`Error converting ${baseName}:`, error);
  }
}

// Main conversion process
async function convertAllEmojis() {
  try {
    console.log('Starting emoji conversion for Safari compatibility...\n');
    
    // Ensure sharp is installed
    try {
      require.resolve('sharp');
    } catch {
      console.error('Sharp is not installed. Installing...');
      const { exec } = require('child_process');
      await new Promise((resolve, reject) => {
        exec('npm install sharp', (error, stdout, stderr) => {
          if (error) {
            console.error('Failed to install sharp:', error);
            reject(error);
          } else {
            console.log('Sharp installed successfully');
            resolve();
          }
        });
      });
    }
    
    // Read all files in emoji directory
    const files = await fs.readdir(EMOJI_DIR);
    const emojiFiles = files
      .filter(file => file.endsWith('.avif'))
      .map(file => path.join(EMOJI_DIR, file));
    
    console.log(`Found ${emojiFiles.length} AVIF emoji files to convert.\n`);
    
    // Convert each emoji
    for (const file of emojiFiles) {
      await convertEmoji(file);
    }
    
    console.log('\n✅ Emoji conversion complete!');
    console.log('All emojis now have WebP and PNG fallback versions.');
    
  } catch (error) {
    console.error('Error during conversion:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  convertAllEmojis();
}

module.exports = { convertEmoji, convertAllEmojis };