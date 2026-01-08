#!/bin/bash

# Script to re-encode AVIF files for iOS Safari compatibility
# Fixes encoding issues that prevent certain AVIF files from displaying on iOS

EMOJI_DIR="/root/onestreamer/server/uploads/emojis"
BACKUP_DIR="/root/onestreamer/server/uploads/emojis_backup_$(date +%Y%m%d_%H%M%S)"
LOG_FILE="/root/onestreamer/avif_reencode.log"

echo "Starting AVIF re-encoding for iOS Safari compatibility..." | tee $LOG_FILE
echo "==========================================" | tee -a $LOG_FILE

# Create backup directory
echo "Creating backup at $BACKUP_DIR..." | tee -a $LOG_FILE
mkdir -p "$BACKUP_DIR"

# Backup all original AVIF files
echo "Backing up original AVIF files..." | tee -a $LOG_FILE
cp -r "$EMOJI_DIR"/*.avif "$BACKUP_DIR/" 2>/dev/null

# Count files
TOTAL_FILES=$(find "$EMOJI_DIR" -name "*.avif" | wc -l)
echo "Found $TOTAL_FILES AVIF files to process" | tee -a $LOG_FILE
echo "" | tee -a $LOG_FILE

SUCCESS_COUNT=0
FAIL_COUNT=0
SKIPPED_COUNT=0

# Process each AVIF file
for avif_file in "$EMOJI_DIR"/*.avif; do
    if [ ! -f "$avif_file" ]; then
        continue
    fi
    
    filename=$(basename "$avif_file")
    echo "Processing: $filename" | tee -a $LOG_FILE
    
    # Check if it's animated (has more than 1 frame)
    frame_count=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_frames -of csv=p=0 "$avif_file" 2>/dev/null)
    
    if [ -z "$frame_count" ]; then
        echo "  ⚠ Could not determine frame count, skipping" | tee -a $LOG_FILE
        ((SKIPPED_COUNT++))
        continue
    fi
    
    # Create temporary file
    temp_file="${avif_file}.tmp.avif"
    
    if [ "$frame_count" -gt 1 ]; then
        echo "  ℹ Animated image detected ($frame_count frames)" | tee -a $LOG_FILE
        
        # For animated AVIF, use different settings
        ffmpeg -i "$avif_file" \
            -c:v libaom-av1 \
            -crf 30 \
            -b:v 0 \
            -pix_fmt yuv420p \
            -color_range tv \
            -colorspace bt709 \
            -color_trc bt709 \
            -color_primaries bt709 \
            -cpu-used 8 \
            -row-mt 1 \
            -tiles 2x2 \
            -enable-global-motion 0 \
            -y "$temp_file" 2>> $LOG_FILE
    else
        echo "  ℹ Static image detected" | tee -a $LOG_FILE
        
        # For static AVIF, use optimized settings
        ffmpeg -i "$avif_file" \
            -c:v libaom-av1 \
            -crf 30 \
            -b:v 0 \
            -pix_fmt yuv420p \
            -color_range tv \
            -colorspace bt709 \
            -color_trc bt709 \
            -color_primaries bt709 \
            -cpu-used 8 \
            -row-mt 1 \
            -tiles 2x2 \
            -g 1 \
            -keyint_min 0 \
            -enable-global-motion 0 \
            -still-picture 1 \
            -y "$temp_file" 2>> $LOG_FILE
    fi
    
    # Check if conversion succeeded
    if [ $? -eq 0 ] && [ -f "$temp_file" ]; then
        # Verify the new file has proper metadata
        new_profile=$(ffprobe -v quiet -print_format json -show_streams "$temp_file" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('streams',[{}])[0]; print(s.get('profile','Unknown'))" 2>/dev/null)
        new_colorspace=$(ffprobe -v quiet -print_format json -show_streams "$temp_file" 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); s=d.get('streams',[{}])[0]; print(s.get('color_space','Unknown'))" 2>/dev/null)
        
        if [ "$new_colorspace" = "bt709" ]; then
            # Replace original with re-encoded version
            mv "$temp_file" "$avif_file"
            echo "  ✓ Successfully re-encoded (Profile: $new_profile, Colorspace: $new_colorspace)" | tee -a $LOG_FILE
            ((SUCCESS_COUNT++))
        else
            echo "  ✗ Re-encoding failed verification (Colorspace: $new_colorspace)" | tee -a $LOG_FILE
            rm -f "$temp_file"
            ((FAIL_COUNT++))
        fi
    else
        echo "  ✗ Re-encoding failed" | tee -a $LOG_FILE
        rm -f "$temp_file"
        ((FAIL_COUNT++))
    fi
    
    echo "" | tee -a $LOG_FILE
done

echo "==========================================" | tee -a $LOG_FILE
echo "Re-encoding complete!" | tee -a $LOG_FILE
echo "  ✓ Success: $SUCCESS_COUNT" | tee -a $LOG_FILE
echo "  ✗ Failed: $FAIL_COUNT" | tee -a $LOG_FILE
echo "  ⚠ Skipped: $SKIPPED_COUNT" | tee -a $LOG_FILE
echo "" | tee -a $LOG_FILE
echo "Original files backed up to: $BACKUP_DIR" | tee -a $LOG_FILE
echo "Log file: $LOG_FILE" | tee -a $LOG_FILE