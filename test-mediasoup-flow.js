const { io } = require('socket.io-client');

console.log('🧪 MEDIASOUP FLOW TEST: Testing full MediaSoup producer/consumer flow...');

class MediaSoupTestClient {
  constructor(name, isStreamer = false) {
    this.name = name;
    this.isStreamer = isStreamer;
    this.socket = null;
    this.serverUrl = 'http://localhost:8080';
  }

  connect() {
    return new Promise((resolve) => {
      this.socket = io(this.serverUrl);
      
      this.socket.on('connect', () => {
        console.log(`✅ ${this.name}: Connected (${this.socket.id})`);
        resolve();
      });

      this.socket.on('takeover-started', (data) => {
        console.log(`📢 ${this.name}: Received takeover-started from ${data.newStreamerId}`);
      });

      this.socket.on('stream-ready', (data) => {
        console.log(`🎬 ${this.name}: Received stream-ready from ${data.streamerId}`);
        
        if (!this.isStreamer) {
          setTimeout(() => this.attemptFullMediaSoupFlow(), 1000);
        }
      });

      this.socket.on('streaming-approved', () => {
        console.log(`🎯 ${this.name}: Streaming approved! Now creating MediaSoup resources...`);
        if (this.isStreamer) {
          setTimeout(() => this.createMediaSoupProducers(), 500);
        }
      });
    });
  }

  async createMediaSoupProducers() {
    try {
      console.log(`📡 ${this.name}: Step 1 - Creating WebRTC transport...`);
      
      // Step 1: Create transport
      const fetch = (await import('node-fetch')).default;
      const transportResponse = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: this.socket.id })
      });
      
      const transportData = await transportResponse.json();
      console.log(`📡 ${this.name}: Transport created: ${transportData.id}`);

      // Step 2: Connect transport (simulate DTLS parameters)
      console.log(`🔗 ${this.name}: Step 2 - Connecting transport...`);
      const connectResponse = await fetch(`${this.serverUrl}/api/mediasoup/connect-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socketId: this.socket.id,
          dtlsParameters: {
            fingerprints: [{
              algorithm: 'sha-256',
              value: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'
            }],
            role: 'client'
          }
        })
      });

      if (!connectResponse.ok) {
        throw new Error(`Failed to connect transport: ${connectResponse.status}`);
      }
      console.log(`🔗 ${this.name}: Transport connected successfully`);

      // Step 3: Create video producer
      console.log(`📺 ${this.name}: Step 3 - Creating video producer...`);
      await this.createProducer('video');

      // Step 4: Create audio producer
      console.log(`🎤 ${this.name}: Step 4 - Creating audio producer...`);
      await this.createProducer('audio');

    } catch (error) {
      console.error(`❌ ${this.name}: MediaSoup setup failed:`, error.message);
    }
  }

  createProducer(kind) {
    return new Promise((resolve, reject) => {
      const rtpParameters = {
        codecs: [{
          mimeType: kind === 'video' ? 'video/VP8' : 'audio/opus',
          clockRate: kind === 'video' ? 90000 : 48000,
          payloadType: kind === 'video' ? 96 : 111
        }],
        headerExtensions: [],
        encodings: [{ maxBitrate: 1000000 }],
        rtcp: { cname: `${this.name}-${kind}` }
      };

      this.socket.emit('mediasoup:produce', { kind, rtpParameters }, (response) => {
        if (response.success) {
          console.log(`✅ ${this.name}: ${kind} producer created: ${response.producerId}`);
          resolve(response);
        } else {
          console.error(`❌ ${this.name}: Failed to create ${kind} producer: ${response.error}`);
          reject(new Error(response.error));
        }
      });
    });
  }

  async attemptFullMediaSoupFlow() {
    try {
      console.log(`📺 ${this.name}: Starting full MediaSoup consumer flow...`);
      
      // Step 1: Get router capabilities
      console.log(`📊 ${this.name}: Step 1 - Getting router capabilities...`);
      const fetch = (await import('node-fetch')).default;
      const capResponse = await fetch(`${this.serverUrl}/api/mediasoup/router-capabilities`);
      const { rtpCapabilities } = await capResponse.json();
      console.log(`📊 ${this.name}: Got router capabilities`);

      // Step 2: Create receive transport
      console.log(`📡 ${this.name}: Step 2 - Creating receive transport...`);
      const transportResponse = await fetch(`${this.serverUrl}/api/mediasoup/create-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ socketId: this.socket.id })
      });
      
      const transportData = await transportResponse.json();
      console.log(`📡 ${this.name}: Receive transport created: ${transportData.id}`);

      // Step 3: Connect receive transport
      console.log(`🔗 ${this.name}: Step 3 - Connecting receive transport...`);
      const connectResponse = await fetch(`${this.serverUrl}/api/mediasoup/connect-transport`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          socketId: this.socket.id,
          dtlsParameters: {
            fingerprints: [{
              algorithm: 'sha-256',
              value: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'
            }],
            role: 'client'
          }
        })
      });

      if (!connectResponse.ok) {
        throw new Error(`Failed to connect receive transport: ${connectResponse.status}`);
      }
      console.log(`🔗 ${this.name}: Receive transport connected`);

      // Step 4: Attempt to consume video
      console.log(`📺 ${this.name}: Step 4 - Attempting to consume video...`);
      await this.attemptConsume('video', rtpCapabilities);

      // Step 5: Attempt to consume audio
      console.log(`🎤 ${this.name}: Step 5 - Attempting to consume audio...`);
      await this.attemptConsume('audio', rtpCapabilities);

    } catch (error) {
      console.error(`❌ ${this.name}: Consumer flow failed:`, error.message);
    }
  }

  attemptConsume(kind, rtpCapabilities) {
    return new Promise((resolve, reject) => {
      this.socket.emit('mediasoup:consume', { 
        rtpCapabilities, 
        kind 
      }, (response) => {
        if (response.success) {
          console.log(`✅ ${this.name}: Successfully created ${kind} consumer: ${response.consumer.id}`);
          
          // Resume the consumer
          this.socket.emit('mediasoup:resume-consumer', {
            consumerId: response.consumer.id
          }, (resumeResponse) => {
            if (resumeResponse.success) {
              console.log(`▶️ ${this.name}: ${kind} consumer resumed successfully`);
              resolve(response);
            } else {
              console.error(`❌ ${this.name}: Failed to resume ${kind} consumer: ${resumeResponse.error}`);
              reject(new Error(resumeResponse.error));
            }
          });
        } else {
          console.log(`❌ ${this.name}: Failed to consume ${kind}: ${response.error}`);
          reject(new Error(response.error));
        }
      });
    });
  }

  requestToStream(streamType = 'webcam') {
    console.log(`🎬 ${this.name}: Requesting to stream (${streamType})...`);
    this.socket.emit('request-to-stream', { streamType });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      console.log(`🔌 ${this.name}: Disconnected`);
    }
  }
}

async function runMediaSoupFlowTest() {
  const streamer1 = new MediaSoupTestClient('Streamer1', true);
  const viewer1 = new MediaSoupTestClient('Viewer1', false);
  const viewer2 = new MediaSoupTestClient('Viewer2', false);

  // Connect all clients
  console.log('\n🔗 Phase 1: Connecting clients...');
  await streamer1.connect();
  await viewer1.connect();
  await viewer2.connect();

  // Wait for connections to settle
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Streamer starts streaming
  console.log('\n🎬 Phase 2: Streamer1 starts streaming and creates producers...');
  streamer1.requestToStream('webcam');
  
  // Wait for stream setup to complete
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Cleanup
  console.log('\n🧹 Cleaning up...');
  streamer1.disconnect();
  viewer1.disconnect();
  viewer2.disconnect();
}

runMediaSoupFlowTest().catch(console.error);