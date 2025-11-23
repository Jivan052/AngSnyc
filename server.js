const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    const messageStr = message.toString();
    console.log('Message received on server:', messageStr);
    const data = JSON.parse(messageStr);
    const { roomId, url, action, time } = data;

    if (!rooms[roomId]) {
      console.log(`Creating new room: ${roomId}`);
      rooms[roomId] = { users: [], videoUrl: url, currentTime: 0, lastUpdate: 0 };
    } else {
      console.log(`Joining existing room: ${roomId}`);
    }

    const room = rooms[roomId];

    switch (action) {
      case 'join':
        room.users.push(ws);
        ws.send(JSON.stringify({ type: 'sync', url: room.videoUrl, time: room.currentTime }));
        break;

      case 'play':
      case 'pause':
      case 'seek':
        const now = Date.now();
        if (now - room.lastUpdate < 300) return; // Debounce updates (300ms gap)
        
        room.lastUpdate = now;
        room.currentTime = time;

        room.users.forEach((user) => {
          if (user !== ws && user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: action, time }));
          }
        });
        break;

      case 'changeUrl':
        room.videoUrl = url;
        room.currentTime = 0;
        room.lastUpdate = 0;
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: 'changeUrl', url, time: 0 }));
          }
        });
        break;
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    Object.keys(rooms).forEach((roomId) => {
      rooms[roomId].users = rooms[roomId].users.filter((user) => user !== ws);
    });
  });
});

server.listen(8080, () => {
  console.log('Server is running on port 8080');
});
