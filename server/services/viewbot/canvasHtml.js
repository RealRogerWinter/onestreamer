// Canvas/test-pattern HTML page for ViewBotInstance, extracted verbatim from
// generateCanvasHTML(). Pure: interpolates config.* + botId into the markup.

function buildCanvasHTML(config, botId) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <title>ViewBot Media Generator</title>
      </head>
      <body>
        <canvas id="media-canvas" width="${config.width}" height="${config.height}"></canvas>
        <script>
          const canvas = document.getElementById('media-canvas');
          const ctx = canvas.getContext('2d');
          let frame = 0;
          let hue = 0;
          
          function drawFrame() {
            // Clear canvas
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Draw content based on type
            const mainContentType = '${config.contentType}';
            const testPattern = '${config.testPattern || 'color-bars'}';
            
            if (mainContentType === 'customText') {
              drawCustomText();
            } else {
              // Test pattern mode
              switch(testPattern) {
                case 'color-bars':
                  drawColorBars();
                  break;
                case 'moving-text':
                  drawMovingText();
                  break;
                case 'clock':
                  drawClock();
                  break;
                case 'noise':
                  drawNoise();
                  break;
                case 'gradient':
                  drawGradient();
                  break;
                default:
                  drawColorBars();
              }
            }
            
            // Draw overlay info
            drawOverlay();
            
            // Update animation variables
            frame++;
            hue = (hue + 2) % 360;
            
            requestAnimationFrame(drawFrame);
          }
          
          function drawColorBars() {
            const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
            const barWidth = canvas.width / colors.length;
            
            colors.forEach((color, index) => {
              ctx.fillStyle = color;
              ctx.fillRect(index * barWidth, 0, barWidth, canvas.height);
            });
          }
          
          function drawMovingText() {
            ctx.fillStyle = '#001122';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const text = 'ViewBot ${botId} - Test Stream';
            const x = ((Date.now() * 0.1) % (canvas.width + 400)) - 400;
            
            ctx.fillStyle = '#00ff88';
            ctx.font = 'bold 48px Arial';
            ctx.textAlign = 'left';
            ctx.fillText(text, x, canvas.height / 2);
          }
          
          function drawClock() {
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            const now = new Date();
            
            ctx.fillStyle = '#00ff00';
            ctx.font = 'bold 72px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(now.toLocaleTimeString(), canvas.width / 2, canvas.height / 2 - 20);
            
            ctx.font = 'bold 32px monospace';
            ctx.fillText(now.toLocaleDateString(), canvas.width / 2, canvas.height / 2 + 40);
          }
          
          function drawNoise() {
            const imageData = ctx.createImageData(canvas.width, canvas.height);
            const data = imageData.data;
            
            for (let i = 0; i < data.length; i += 4) {
              const noise = Math.random() * 255;
              data[i] = noise;     // Red
              data[i + 1] = noise; // Green
              data[i + 2] = noise; // Blue
              data[i + 3] = 255;   // Alpha
            }
            
            ctx.putImageData(imageData, 0, 0);
          }
          
          function drawGradient() {
            // Create animated rainbow gradient
            const time = Date.now() * 0.001;
            
            // Horizontal gradient with shifting colors
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
            
            for (let i = 0; i <= 1; i += 0.1) {
              const hue = ((i * 360 + time * 50) % 360);
              const color = 'hsl(' + hue + ', 100%, 50%)';
              gradient.addColorStop(i, color);
            }
            
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Add vertical gradient overlay
            const vertGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
            vertGradient.addColorStop(0, 'rgba(255,255,255,0.2)');
            vertGradient.addColorStop(0.5, 'rgba(255,255,255,0)');
            vertGradient.addColorStop(1, 'rgba(0,0,0,0.2)');
            
            ctx.fillStyle = vertGradient;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
          }
          
          function drawCustomText() {
            // Background color
            ctx.fillStyle = '${config.backgroundColor || '#001122'}';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            
            // Custom text
            const text = '${config.customText || 'Custom Text'}';
            const textColor = '${config.textColor || '#00ff88'}';
            const fontSize = ${config.fontSize || 48};
            
            ctx.fillStyle = textColor;
            ctx.font = 'bold ' + fontSize + 'px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Split text into lines if it's too long
            const maxWidth = canvas.width - 40;
            const lines = [];
            const words = text.split(' ');
            let currentLine = words[0];
            
            for (let i = 1; i < words.length; i++) {
              const word = words[i];
              const width = ctx.measureText(currentLine + ' ' + word).width;
              if (width < maxWidth) {
                currentLine += ' ' + word;
              } else {
                lines.push(currentLine);
                currentLine = word;
              }
            }
            lines.push(currentLine);
            
            // Draw each line
            const lineHeight = fontSize * 1.2;
            const totalHeight = lines.length * lineHeight;
            const startY = (canvas.height - totalHeight) / 2 + lineHeight / 2;
            
            for (let i = 0; i < lines.length; i++) {
              const y = startY + (i * lineHeight);
              ctx.fillText(lines[i], canvas.width / 2, y);
            }
          }
          
          function drawOverlay() {
            // Semi-transparent overlay
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(0, 0, canvas.width, 40);
            ctx.fillRect(0, canvas.height - 60, canvas.width, 60);
            
            // Top text
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('ViewBot ${botId}', canvas.width / 2, 25);
            
            // Bottom text
            ctx.font = '12px Arial';
            ctx.fillText('Frame: ' + frame + ' | ' + new Date().toLocaleTimeString(), canvas.width / 2, canvas.height - 35);
            ctx.fillText('Resolution: ${config.width}×${config.height} | FPS: ${config.frameRate}', canvas.width / 2, canvas.height - 15);
          }
          
          // Start animation
          drawFrame();
        </script>
      </body>
      </html>
    `;
}

module.exports = { buildCanvasHTML };
