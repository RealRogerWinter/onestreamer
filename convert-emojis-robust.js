#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const EMOJI_DIR = path.join(__dirname, 'server', 'uploads', 'emojis');

// Check if a file is animated
async function isAnimated(filePath) {
  try {
    // Use ffprobe to check if file has multiple frames
    const { stdout } = await execPromise(`ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of csv=p=0 "${filePath}"`);
    const frameCount = parseInt(stdout.trim());
    return frameCount > 1;
  } catch (error) {
    // If ffprobe fails, assume it's not animated
    return false;
  }
}

// Get file type using file command
async function getFileType(filePath) {
  try {
    const { stdout } = await execPromise(`file --mime-type -b "${filePath}"`);
    return stdout.trim();
  } catch (error) {
    return 'unknown';
  }
}

// Convert a single emoji to multiple formats using ImageMagick
async function convertEmoji(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, ext);
  const dirName = path.dirname(filePath);
  
  console.log(`\n📷 Processing ${baseName}${ext}...`);
  
  try {
    // Check file type
    const mimeType = await getFileType(filePath);
    console.log(`  File type: ${mimeType}`);
    
    // Check if animated
    const animated = await isAnimated(filePath);
    console.log(`  Animated: ${animated}`);
    
    // Define output paths
    const webpPath = path.join(dirName, `${baseName}.webp`);
    const pngPath = path.join(dirName, `${baseName}.png`);
    const gifPath = path.join(dirName, `${baseName}.gif`);
    const jpgPath = path.join(dirName, `${baseName}.jpg`);
    
    if (animated) {
      // For animated images, convert to animated WebP and GIF
      console.log('  Converting animated image...');
      
      // Convert to animated WebP (better compression, wide support)
      try {
        await execPromise(`ffmpeg -i "${filePath}" -c:v libwebp -lossless 0 -compression_level 6 -quality 90 -loop 0 -preset default -an -vsync 0 "${webpPath}" -y`);
        console.log(`  ✓ Created animated WebP: ${baseName}.webp`);
      } catch (error) {
        console.error(`  ✗ Failed to create animated WebP: ${error.message}`);
      }
      
      // Convert to GIF (universal fallback for animated)
      if (!filePath.endsWith('.gif')) {
        try {
          await execPromise(`ffmpeg -i "${filePath}" -vf "fps=20,scale=128:128:flags=lanczos" "${gifPath}" -y`);
          console.log(`  ✓ Created GIF: ${baseName}.gif`);
        } catch (error) {
          console.error(`  ✗ Failed to create GIF: ${error.message}`);
        }
      }
      
      // Create static PNG preview (first frame only)
      try {
        await execPromise(`ffmpeg -i "${filePath}" -vframes 1 "${pngPath}" -y`);
        console.log(`  ✓ Created PNG preview: ${baseName}.png`);
      } catch (error) {
        console.error(`  ✗ Failed to create PNG: ${error.message}`);
      }
      
    } else {
      // For static images, use ImageMagick for better quality
      console.log('  Converting static image...');
      
      // Convert to WebP
      try {
        await execPromise(`convert "${filePath}" -quality 95 -define webp:lossless=false -define webp:method=6 "${webpPath}"`);
        console.log(`  ✓ Created WebP: ${baseName}.webp`);
      } catch (error) {
        console.error(`  ✗ Failed to create WebP: ${error.message}`);
      }
      
      // Convert to PNG
      try {
        await execPromise(`convert "${filePath}" -quality 100 "${pngPath}"`);
        console.log(`  ✓ Created PNG: ${baseName}.png`);
      } catch (error) {
        console.error(`  ✗ Failed to create PNG: ${error.message}`);
      }
      
      // Convert to JPEG (smallest file size for photos)
      try {
        await execPromise(`convert "${filePath}" -quality 90 -background white -flatten "${jpgPath}"`);
        console.log(`  ✓ Created JPEG: ${baseName}.jpg`);
      } catch (error) {
        console.error(`  ✗ Failed to create JPEG: ${error.message}`);
      }
    }
    
    // If original is AVIF, try to re-encode with better compatibility
    if (ext === '.avif') {
      try {
        const tempPath = path.join(dirName, `${baseName}_temp.avif`);
        // Convert to PNG first, then back to AVIF with specific settings
        await execPromise(`convert "${filePath}" "${pngPath}.tmp"`);
        await execPromise(`convert "${pngPath}.tmp" -quality 85 "${tempPath}"`);
        await execPromise(`mv "${tempPath}" "${filePath}"`);
        await execPromise(`rm "${pngPath}.tmp"`);
        console.log(`  ✓ Re-encoded AVIF for better compatibility`);
      } catch (error) {
        console.error(`  ✗ Failed to re-encode AVIF: ${error.message}`);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error converting ${baseName}:`, error.message);
    return false;
  }
}

// Check and install required dependencies
async function checkDependencies() {
  const deps = ['ffmpeg', 'ffprobe', 'convert'];
  const missing = [];
  
  for (const dep of deps) {
    try {
      await execPromise(`which ${dep}`);
    } catch {
      missing.push(dep);
    }
  }
  
  if (missing.length > 0) {
    console.log('📦 Installing missing dependencies...');
    for (const dep of missing) {
      try {
        if (dep === 'convert') {
          await execPromise('apt-get update && apt-get install -y imagemagick');
          console.log('  ✓ Installed ImageMagick');
        } else {
          await execPromise(`apt-get update && apt-get install -y ${dep}`);
          console.log(`  ✓ Installed ${dep}`);
        }
      } catch (error) {
        console.error(`  ✗ Failed to install ${dep}:`, error.message);
        return false;
      }
    }
  }
  
  return true;
}

// Main conversion process
async function convertAllEmojis() {
  try {
    console.log('🎨 Starting robust emoji conversion for cross-browser compatibility...\n');
    
    // Check dependencies
    if (!await checkDependencies()) {
      console.error('❌ Failed to install required dependencies');
      process.exit(1);
    }
    
    // Read all files in emoji directory
    const files = await fs.readdir(EMOJI_DIR);
    const emojiFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.avif', '.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext);
    });
    
    // Group files by base name to avoid duplicate conversions
    const uniqueEmojis = new Map();
    for (const file of emojiFiles) {
      const ext = path.extname(file).toLowerCase();
      const baseName = path.basename(file, ext);
      
      // Skip already converted files (those with our suffixes)
      if (baseName.endsWith('_temp') || baseName.endsWith('.tmp')) continue;
      
      if (!uniqueEmojis.has(baseName)) {
        uniqueEmojis.set(baseName, []);
      }
      uniqueEmojis.get(baseName).push({ file, ext });
    }
    
    console.log(`Found ${uniqueEmojis.size} unique emojis to process.\n`);
    
    let successCount = 0;
    let failCount = 0;
    
    // Convert each unique emoji
    for (const [baseName, files] of uniqueEmojis) {
      // Prefer AVIF or GIF as source
      const sourceFile = files.find(f => f.ext === '.avif') 
                      || files.find(f => f.ext === '.gif')
                      || files[0];
      
      if (sourceFile) {
        const fullPath = path.join(EMOJI_DIR, sourceFile.file);
        const success = await convertEmoji(fullPath);
        if (success) successCount++;
        else failCount++;
      }
    }
    
    console.log('\n✅ Emoji conversion complete!');
    console.log(`📊 Results: ${successCount} successful, ${failCount} failed`);
    console.log('\n📱 Safari iOS compatibility ensured with multiple fallback formats.');
    
  } catch (error) {
    console.error('Error during conversion:', error);
    process.exit(1);
  }
}

// Clean up duplicate/unnecessary files
async function cleanupDuplicates() {
  try {
    console.log('\n🧹 Cleaning up temporary files...');
    const files = await fs.readdir(EMOJI_DIR);
    
    for (const file of files) {
      if (file.includes('_temp') || file.includes('.tmp')) {
        await fs.unlink(path.join(EMOJI_DIR, file));
        console.log(`  Removed: ${file}`);
      }
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}

// Run if called directly
if (require.main === module) {
  convertAllEmojis().then(() => {
    return cleanupDuplicates();
  }).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = { convertEmoji, convertAllEmojis };