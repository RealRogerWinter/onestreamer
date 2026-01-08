const { IngressClient } = require('livekit-server-sdk');

async function cleanupIngress() {
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const host = process.env.LIVEKIT_HOST || 'http://127.0.0.1:7882';

  const ingressClient = new IngressClient(host, apiKey, apiSecret);

  try {
    console.log('📋 Listing all ingress instances...');
    const ingresses = await ingressClient.listIngress();
    console.log(`Found ${ingresses.length} ingress instance(s)`);

    for (const ingress of ingresses) {
      console.log(`🗑️  Deleting ingress: ${ingress.ingressId} (${ingress.name})`);
      await ingressClient.deleteIngress(ingress.ingressId);
      console.log(`✅ Deleted: ${ingress.ingressId}`);
    }

    console.log('✅ All ingress instances cleaned up');
  } catch (error) {
    console.error('❌ Error cleaning up ingress:', error);
  }
}

cleanupIngress();
