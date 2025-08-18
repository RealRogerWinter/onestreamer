const io = require("socket.io-client");
const serverUrl = "http://localhost:8080";

console.log("Testing buff system fixes...");

const socket = io(serverUrl);

socket.on("connect", () => {
    console.log("Connected to server");
    socket.emit("get-my-buffs");
    socket.emit("get-streamer-buffs");
});

socket.on("my-buffs-update", (data) => {
    console.log("My buffs update:", data.buffs.length, "buffs");
});

socket.on("streamer-buffs-update", (data) => {
    console.log("Streamer buffs update:", data.buffs.length, "buffs");  
});

socket.on("buff-error", (data) => {
    console.log("Buff error:", data.error);
});

setTimeout(() => socket.disconnect(), 5000);
EOF < /dev/null
