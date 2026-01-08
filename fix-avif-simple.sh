#!/bin/bash

# Simple AVIF fix - convert from PNG/GIF sources when available

EMOJI_DIR="/root/onestreamer/server/uploads/emojis"
LOG_FILE="/root/onestreamer/avif_simple_fix.log"

echo "Simple AVIF fix - using alternative sources..." | tee $LOG_FILE
echo "==========================================" | tee -a $LOG_FILE

SUCCESS_COUNT=0
FAIL_COUNT=0

# Process each AVIF file
for avif_file in "$EMOJI_DIR"/*.avif; do
    if [ ! -f "$avif_file" ]; then
        continue
    fi
    
    basename_no_ext="${avif_file%.*}"
    filename=$(basename "$avif_file")
    
    echo "Processing: $filename" | tee -a $LOG_FILE
    
    # Check if PNG exists
    if [ -f "${basename_no_ext}.png" ]; then
        echo "  Found PNG source, converting..." | tee -a $LOG_FILE
        ffmpeg -i "${basename_no_ext}.png" \
            -c:v libsvtav1 \
            -crf 30 \
            -pix_fmt yuv420p \
            -vf "scale='min(128,iw)':'min(128,ih)':flags=lanczos" \
            -y "${avif_file}.new" 2>> $LOG_FILE
            
        if [ $? -eq 0 ] && [ -f "${avif_file}.new" ]; then
            mv "${avif_file}.new" "$avif_file"
            echo "  ✓ Converted from PNG" | tee -a $LOG_FILE
            ((SUCCESS_COUNT++))
        else
            rm -f "${avif_file}.new"
            echo "  ✗ PNG conversion failed" | tee -a $LOG_FILE
            ((FAIL_COUNT++))
        fi
        
    # Check if GIF exists
    elif [ -f "${basename_no_ext}.gif" ]; then
        echo "  Found GIF source, converting..." | tee -a $LOG_FILE
        
        # For GIF, just extract first frame as AVIF
        ffmpeg -i "${basename_no_ext}.gif" \
            -vframes 1 \
            -c:v libsvtav1 \
            -crf 30 \
            -pix_fmt yuv420p \
            -vf "scale='min(128,iw)':'min(128,ih)':flags=lanczos" \
            -y "${avif_file}.new" 2>> $LOG_FILE
            
        if [ $? -eq 0 ] && [ -f "${avif_file}.new" ]; then
            mv "${avif_file}.new" "$avif_file"
            echo "  ✓ Converted from GIF (first frame)" | tee -a $LOG_FILE
            ((SUCCESS_COUNT++))
        else
            rm -f "${avif_file}.new"
            echo "  ✗ GIF conversion failed" | tee -a $LOG_FILE
            ((FAIL_COUNT++))
        fi
        
    else
        echo "  ⚠ No alternative source found" | tee -a $LOG_FILE
        ((FAIL_COUNT++))
    fi
    
    echo "" | tee -a $LOG_FILE
done

echo "==========================================" | tee -a $LOG_FILE
echo "Simple fix complete!" | tee -a $LOG_FILE
echo "  ✓ Success: $SUCCESS_COUNT" | tee -a $LOG_FILE
echo "  ✗ Failed: $FAIL_COUNT" | tee -a $LOG_FILE