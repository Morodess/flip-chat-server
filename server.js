const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

const clients = new Map();

wss.on("connection", (ws) => {
    let username = null;

    ws.on("message", (message) => {
        const data = JSON.parse(message);

        if (data.type === "auth") {
            username = data.user;
            clients.set(username, ws);
        }

        if (data.type === "message") {
            for (let [_, client] of clients) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: "message",
                        from: data.from,
                        text: data.text,
                        chat: data.chat
                    }));
                }
            }
        }
    });

    ws.on("close", () => {
        if (username) {
            clients.delete(username);
        }
    });
});

console.log("WebSocket server running on port", PORT);
