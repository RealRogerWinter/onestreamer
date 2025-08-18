export class TestStreamGenerator {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private audioContext: AudioContext | null = null;
  private animationId: number | null = null;
  private oscillator: OscillatorNode | null = null;
  private gainNode: GainNode | null = null;

  constructor(
    private width = 640,
    private height = 480,
    private frameRate = 30,
    private contentType = 'color-bars'
  ) {}

  generateVideoStream(): MediaStream {
    // Create canvas for video generation
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d')!;

    // Start animation loop
    this.startVideoAnimation();

    // Capture stream from canvas
    const stream = this.canvas.captureStream(this.frameRate);
    
    console.log('📹 TEST: Generated video stream with tracks:', stream.getVideoTracks().length);
    return stream;
  }

  generateAudioStream(): MediaStream {
    // Create audio context
    this.audioContext = new AudioContext();
    
    // Create oscillator for tone generation
    this.oscillator = this.audioContext.createOscillator();
    this.gainNode = this.audioContext.createGain();
    
    // Create media stream destination
    const destination = this.audioContext.createMediaStreamDestination();
    
    // Connect nodes: oscillator -> gain -> destination
    this.oscillator.connect(this.gainNode);
    this.gainNode.connect(destination);
    
    // Configure oscillator
    this.oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime); // A4 note
    this.oscillator.type = 'sine';
    
    // Set low volume
    this.gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime);
    
    // Start oscillator
    this.oscillator.start();
    
    console.log('🎵 TEST: Generated audio stream with tracks:', destination.stream.getAudioTracks().length);
    return destination.stream;
  }

  generateCombinedStream(): MediaStream {
    const videoStream = this.generateVideoStream();
    const audioStream = this.generateAudioStream();
    
    const combinedStream = new MediaStream();
    
    // Add video tracks
    videoStream.getVideoTracks().forEach(track => {
      combinedStream.addTrack(track);
    });
    
    // Add audio tracks
    audioStream.getAudioTracks().forEach(track => {
      combinedStream.addTrack(track);
    });
    
    console.log('🎬 TEST: Generated combined stream - Video tracks:', 
      combinedStream.getVideoTracks().length, 'Audio tracks:', combinedStream.getAudioTracks().length);
    
    return combinedStream;
  }

  private startVideoAnimation(): void {
    if (!this.ctx) return;
    
    let frame = 0;
    let hue = 0;
    
    const animate = () => {
      if (!this.ctx || !this.canvas) return;
      
      // Clear canvas
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      
      // Draw content based on type
      this.drawContent(frame, hue);
      
      // Common text overlay
      this.drawTextOverlay(frame);
      
      // Update animation variables
      frame++;
      hue = (hue + 2) % 360;
      
      this.animationId = requestAnimationFrame(animate);
    };
    
    animate();
  }

  private drawContent(frame: number, hue: number): void {
    if (!this.ctx || !this.canvas) return;

    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    const time = Date.now() / 1000;

    switch (this.contentType) {
      case 'color-bars':
        this.drawColorBars();
        break;

      case 'noise':
        this.drawNoise();
        break;

      case 'gradient':
        this.drawGradient(hue);
        break;

      case 'moving-text':
        this.drawMovingText(time);
        break;

      case 'clock':
        this.drawClock();
        break;

      default:
        // Default animated pattern
        this.drawAnimatedCircles(hue, time, centerX, centerY);
        break;
    }
  }

  private drawColorBars(): void {
    if (!this.ctx || !this.canvas) return;
    
    const colors = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
    const barWidth = this.canvas.width / colors.length;
    const canvasHeight = this.canvas.height;
    
    colors.forEach((color, index) => {
      this.ctx!.fillStyle = color;
      this.ctx!.fillRect(index * barWidth, 0, barWidth, canvasHeight);
    });
  }

  private drawNoise(): void {
    if (!this.ctx || !this.canvas) return;
    
    const imageData = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    const data = imageData.data;
    
    for (let i = 0; i < data.length; i += 4) {
      const noise = Math.random() * 255;
      data[i] = noise;     // Red
      data[i + 1] = noise; // Green
      data[i + 2] = noise; // Blue
      data[i + 3] = 255;   // Alpha
    }
    
    this.ctx.putImageData(imageData, 0, 0);
  }

  private drawGradient(hue: number): void {
    if (!this.ctx || !this.canvas) return;
    
    const gradient = this.ctx.createLinearGradient(0, 0, this.canvas.width, this.canvas.height);
    gradient.addColorStop(0, `hsl(${hue}, 70%, 50%)`);
    gradient.addColorStop(0.5, `hsl(${(hue + 120) % 360}, 70%, 50%)`);
    gradient.addColorStop(1, `hsl(${(hue + 240) % 360}, 70%, 50%)`);
    
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawMovingText(time: number): void {
    if (!this.ctx || !this.canvas) return;
    
    // Scrolling background
    this.ctx.fillStyle = '#001122';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    const text = 'OneStreamer Test Stream - Generated Content';
    const scrollSpeed = 100;
    const x = ((time * scrollSpeed) % (this.canvas.width + 400)) - 400;
    
    this.ctx.fillStyle = '#00ff88';
    this.ctx.font = 'bold 48px Arial';
    this.ctx.textAlign = 'left';
    this.ctx.fillText(text, x, this.canvas.height / 2);
  }

  private drawClock(): void {
    if (!this.ctx || !this.canvas) return;
    
    // Dark background
    this.ctx.fillStyle = '#111111';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    const centerX = this.canvas.width / 2;
    const centerY = this.canvas.height / 2;
    const now = new Date();
    
    // Digital clock display
    this.ctx.fillStyle = '#00ff00';
    this.ctx.font = 'bold 72px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText(now.toLocaleTimeString(), centerX, centerY - 20);
    
    this.ctx.font = 'bold 32px monospace';
    this.ctx.fillText(now.toLocaleDateString(), centerX, centerY + 40);
  }

  private drawAnimatedCircles(hue: number, time: number, centerX: number, centerY: number): void {
    if (!this.ctx || !this.canvas) return;
    
    // Animated background gradient
    const gradient = this.ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, this.canvas.width / 2);
    gradient.addColorStop(0, `hsl(${hue}, 60%, 30%)`);
    gradient.addColorStop(1, `hsl(${(hue + 60) % 360}, 40%, 10%)`);
    
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Animated circles
    for (let i = 0; i < 3; i++) {
      const angle = (time + i * 2) % (Math.PI * 2);
      const radius = 50 + i * 30;
      const x = centerX + Math.cos(angle) * (radius / 2);
      const y = centerY + Math.sin(angle) * (radius / 2);
      
      this.ctx.beginPath();
      this.ctx.arc(x, y, 20, 0, Math.PI * 2);
      this.ctx.fillStyle = `hsl(${(hue + i * 60) % 360}, 80%, 60%)`;
      this.ctx.fill();
    }
  }

  private drawTextOverlay(frame: number): void {
    if (!this.ctx || !this.canvas) return;
    
    // Semi-transparent overlay for better text readability
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    this.ctx.fillRect(0, 0, this.canvas.width, 40);
    this.ctx.fillRect(0, this.canvas.height - 80, this.canvas.width, 80);
    
    const centerX = this.canvas.width / 2;
    
    // Top text
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = 'bold 20px Arial';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('TEST STREAM', centerX, 28);
    
    // Bottom text
    this.ctx.font = '14px Arial';
    this.ctx.fillText(`Frame: ${frame} | ${new Date().toLocaleTimeString()}`, centerX, this.canvas.height - 50);
    this.ctx.fillText(`Resolution: ${this.canvas.width}×${this.canvas.height} | FPS: ${this.frameRate}`, centerX, this.canvas.height - 30);
    this.ctx.fillText(`Content: ${this.contentType}`, centerX, this.canvas.height - 10);
  }

  cleanup(): void {
    // Stop animation
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    
    // Stop audio
    if (this.oscillator) {
      this.oscillator.stop();
      this.oscillator.disconnect();
      this.oscillator = null;
    }
    
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    // Clean up canvas
    this.canvas = null;
    this.ctx = null;
    
    console.log('🧹 TEST: Test stream generator cleaned up');
  }
}

export default TestStreamGenerator;