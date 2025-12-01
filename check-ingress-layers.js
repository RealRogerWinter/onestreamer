const { IngressClient } = require('livekit-server-sdk');

async function checkIngressLayers() {
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const host = process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882';

  const ingressClient = new IngressClient(host, apiKey, apiSecret);

  try {
    const ingresses = await ingressClient.listIngress();

    for (const ingress of ingresses) {
      console.log(`\n📋 Ingress: ${ingress.ingressId} (${ingress.name})`);
      console.log(`   State: ${ingress.state?.status}`);
      console.log(`   Video Preset: ${ingress.video?.preset || 'NONE'}`);
      console.log(`   Audio Preset: ${ingress.audio?.preset || 'NONE'}`);
      console.log(`   Enable Transcoding: ${ingress.enableTranscoding}`);

      // Check video layers if available
      if (ingress.video) {
        console.log(`   Video config:`, JSON.stringify(ingress.video, null, 4));
      }
    }
  } catch (error) {
    console.error('❌ Error checking ingress:', error);
  }
}

checkIngressLayers();
