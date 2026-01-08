#!/bin/bash

# Script to re-encode AVIF files using avifenc for iOS Safari compatibility
# Uses PNG/GIF sources when available and proper encoding settings

EMOJI_DIR="/root/onestreamer/server/uploads/emojis"
BACKUP_DIR="/root/onestreamer/server/uploads/emojis_backup_avifenc_$(date +%Y%m%d_%H%M%S)"
LOG_FILE="/root/onestreamer/avifenc_conversion.log"

echo "Starting AVIF conversion with avifenc for iOS Safari compatibility..." | tee $LOG_FILE
echo "==========================================" | tee -a $LOG_FILE

# Create backup directory
echo "Creating backup at $BACKUP_DIR..." | tee -a $LOG_FILE
mkdir -p "$BACKUP_DIR"

# Backup all original AVIF files
echo "Backing up original AVIF files..." | tee -a $LOG_FILE
cp "$EMOJI_DIR"/*.avif "$BACKUP_DIR/" 2>/dev/null

SUCCESS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

# Process each AVIF file
for avif_file in "$EMOJI_DIR"/*.avif; do
    if [ ! -f "$avif_file" ]; then
        continue
    fi
    
    basename_no_ext="${avif_file%.*}"
    filename=$(basename "$avif_file")
    
    echo "Processing: $filename" | tee -a $LOG_FILE
    
    # Prioritize source files: PNG > JPG > GIF
    source_file=""
    
    if [ -f "${basename_no_ext}.png" ]; then
        source_file="${basename_no_ext}.png"
        echo "  ℹ Using PNG source" | tee -a $LOG_FILE
    elif [ -f "${basename_no_ext}.jpg" ]; then
        source_file="${basename_no_ext}.jpg"
        echo "  ℹ Using JPG source" | tee -a $LOG_FILE
    elif [ -f "${basename_no_ext}.jpeg" ]; then
        source_file="${basename_no_ext}.jpeg"
        echo "  ℹ Using JPEG source" | tee -a $LOG_FILE
    elif [ -f "${basename_no_ext}.gif" ]; then
        # For GIF, extract first frame to PNG then convert
        echo "  ℹ Using GIF source (extracting first frame)" | tee -a $LOG_FILE
        temp_png="/tmp/${filename%.avif}.png"
        ffmpeg -i "${basename_no_ext}.gif" -vframes 1 -y "$temp_png" 2>/dev/null
        if [ -f "$temp_png" ]; then
            source_file="$temp_png"
        fi
    fi
    
    if [ -z "$source_file" ] || [ ! -f "$source_file" ]; then
        # Try to convert from existing AVIF to PNG then back to AVIF with proper settings
        echo "  ⚠ No alternative source, attempting AVIF re-encode" | tee -a $LOG_FILE
        temp_png="/tmp/${filename%.avif}_temp.png"
        
        # Decode AVIF to PNG
        avifdec "$avif_file" "$temp_png" 2>/dev/null
        
        if [ -f "$temp_png" ]; then
            source_file="$temp_png"
        else
            echo "  ✗ Could not decode AVIF file" | tee -a $LOG_FILE
            ((FAIL_COUNT++))
            echo "" | tee -a $LOG_FILE
            continue
        fi
    fi
    
    # Convert to AVIF with Safari-compatible settings
    temp_avif="${avif_file}.new"
    
    # Use avifenc with specific settings for Safari compatibility
    # - Quality 85 (good balance)
    # - Speed 6 (default)
    # - YUV 420 for better compatibility
    # - Limited range for broadcast compatibility
    # - Auto-tiling for better decoding
    avifenc \
        --qcolor 85 \
        --speed 6 \
        --yuv 420 \
        --range limited \
        --cicp 1/13/6 \
        --autotiling \
        --jobs all \
        "$source_file" \
        "$temp_avif" 2>> $LOG_FILE
    
    # Check if conversion succeeded
    if [ $? -eq 0 ] && [ -f "$temp_avif" ]; then
        # Verify the new file exists and has size > 0
        if [ -s "$temp_avif" ]; then
            # Replace original with new version
            mv "$temp_avif" "$avif_file"
            echo "  ✓ Successfully converted" | tee -a $LOG_FILE
            ((SUCCESS_COUNT++))
        else
            echo "  ✗ Verification failed (empty file)" | tee -a $LOG_FILE
            rm -f "$temp_avif"
            ((FAIL_COUNT++))
        fi
    else
        echo "  ✗ Conversion failed" | tee -a $LOG_FILE
        rm -f "$temp_avif"
        ((FAIL_COUNT++))
    fi
    
    # Clean up temp files
    if [[ "$source_file" == /tmp/* ]]; then
        rm -f "$source_file"
    fi
    
    echo "" | tee -a $LOG_FILE
done

echo "==========================================" | tee -a $LOG_FILE
echo "Conversion complete!" | tee -a $LOG_FILE
echo "  ✓ Success: $SUCCESS_COUNT" | tee -a $LOG_FILE
echo "  ✗ Failed: $FAIL_COUNT" | tee -a $LOG_FILE
echo "  ⚠ Skipped: $SKIP_COUNT" | tee -a $LOG_FILE
echo "" | tee -a $LOG_FILE
echo "Original files backed up to: $BACKUP_DIR" | tee -a $LOG_FILE
echo "Log file: $LOG_FILE" | tee -a $LOG_FILE