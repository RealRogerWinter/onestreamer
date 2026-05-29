// Pure canvas test-pattern rendering, extracted from WebRTCViewer so it can be
// unit-tested and reused without pulling in component state.

function drawColorBars(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
  const barWidth = width / colors.length;

  colors.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(index * barWidth, 0, barWidth, height);
  });
}

function drawMovingText(ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number) {
  ctx.fillStyle = '#000080';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'white';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';

  const text = `OneStreamer Test • ${Math.floor(elapsed / 1000)}s`;
  const x = width / 2;
  const y = height / 2 + Math.sin(elapsed / 1000) * 50;

  ctx.fillText(text, x, y);
}

function drawClock(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = '#001122';
  ctx.fillRect(0, 0, width, height);

  const now = new Date();
  ctx.fillStyle = 'white';
  ctx.font = 'bold 64px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(now.toLocaleTimeString(), width / 2, height / 2 - 20);

  ctx.font = 'bold 32px monospace';
  ctx.fillText(now.toLocaleDateString(), width / 2, height / 2 + 40);
}

function drawNoise(ctx: CanvasRenderingContext2D, width: number, height: number) {
  const imageData = ctx.createImageData(width, height);
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

function drawGradient(ctx: CanvasRenderingContext2D, width: number, height: number, elapsed: number) {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  const hue = (elapsed / 50) % 360;
  gradient.addColorStop(0, `hsl(${hue}, 100%, 50%)`);
  gradient.addColorStop(0.5, `hsl(${(hue + 120) % 360}, 100%, 50%)`);
  gradient.addColorStop(1, `hsl(${(hue + 240) % 360}, 100%, 50%)`);

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function drawSolidColor(ctx: CanvasRenderingContext2D, width: number, height: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
}

// Renders a single test-pattern frame (clear + pattern + HUD overlay).
export function renderTestPatternFrame(
  ctx: CanvasRenderingContext2D,
  pattern: string,
  width: number,
  height: number,
  elapsed: number,
  frameCount: number,
): void {
  ctx.clearRect(0, 0, width, height);

  switch (pattern) {
    case 'color-bars':
      drawColorBars(ctx, width, height);
      break;
    case 'moving-text':
      drawMovingText(ctx, width, height, elapsed);
      break;
    case 'clock':
      drawClock(ctx, width, height);
      break;
    case 'noise':
      drawNoise(ctx, width, height);
      break;
    case 'gradient':
      drawGradient(ctx, width, height, elapsed);
      break;
    default:
      drawSolidColor(ctx, width, height, '#808080');
  }

  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(10, 10, 300, 60);
  ctx.fillStyle = 'white';
  ctx.font = '16px monospace';
  ctx.fillText(`OneStreamer Test Pattern`, 20, 30);
  ctx.fillText(`Frame: ${frameCount} | Uptime: ${Math.floor(elapsed / 1000)}s`, 20, 50);
}
