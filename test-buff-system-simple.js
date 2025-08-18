#\!/usr/bin/env node

/**
 * Simple Buff System Test Script
 * Tests the corrected buff/debuff system behavior
 */

const io = require("socket.io-client");

const serverUrl = process.env.REACT_APP_SERVER_URL || "http://localhost:8080";

console.log("🚀 Starting Simple Buff System Test...");

// Connect as a test user
const socket = io(serverUrl, {
    auth: {
        token: "test-token-1"
    }
});

socket.on("connect", () => {
    console.log("✅ Connected to server");
    
    // Request current buff status
    console.log("🔍 Requesting my buffs...");
    socket.emit("get-my-buffs");
    
    console.log("🔍 Requesting streamer buffs...");
    socket.emit("get-streamer-buffs");
});

// Listen for buff-related events
socket.on("my-buffs-update", (data) => {
    console.log(`🎭 My buffs update: ${data.buffs.length} buffs`);
    data.buffs.forEach(buff => {
        console.log(`  - ${buff.displayName} (${buff.buffType}): ${buff.remainingSeconds}s remaining`);
    });
});

socket.on("user-buff-update", (data) => {
    console.log(`🎭 User ${data.userId} buff update: ${data.buffs.length} buffs`);
});

socket.on("streamer-buffs-update", (data) => {
    console.log(`🎭 Streamer buffs update: ${data.buffs.length} buffs`);
    data.buffs.forEach(buff => {
        console.log(`  - ${buff.displayName} (${buff.buffType}): ${buff.remainingSeconds}s remaining`);
    });
});

socket.on("buff-applied", (data) => {
    console.log(`🎭 Buff applied: ${data.displayName} (${data.buffType})`);
});

socket.on("buff-expired", (data) => {
    console.log(`🎭 Buff expired: ${data.buffId}, reason: ${data.reason}`);
});

socket.on("buff-error", (data) => {
    console.log(`❌ Buff error: ${data.error}`);
});

// Stream events
socket.on("streaming-approved", () => {
    console.log("📺 Streaming approved\!");
});

socket.on("stream-ended", () => {
    console.log("📺 Stream ended\!");
});

socket.on("connect_error", (error) => {
    console.error("❌ Connection error:", error);
});

// Test sequence
setTimeout(() => {
    console.log("\n📋 TEST: Requesting to stream...");
    socket.emit("request-to-stream", { streamType: "webcam" });
}, 3000);

setTimeout(() => {
    console.log("\n📋 TEST: Stopping stream...");
    socket.emit("stop-streaming");
}, 10000);

setTimeout(() => {
    console.log("\n📋 TEST: Final buff check...");
    socket.emit("get-my-buffs");
    socket.emit("get-streamer-buffs");
}, 13000);

setTimeout(() => {
    console.log("\n✅ Test complete");
    process.exit(0);
}, 15000);
EOF < /dev/null
