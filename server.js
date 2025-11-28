const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// YouTube Search API
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const scripts = $('script').toArray();
    let videos = [];
    
    for (const script of scripts) {
      const content = $(script).html();
      if (content && content.includes('var ytInitialData')) {
        const jsonMatch = content.match(/var ytInitialData = ({.*?});/);
        if (jsonMatch) {
          const data = JSON.parse(jsonMatch[1]);
          const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
          
          if (contents) {
            for (const section of contents) {
              const items = section?.itemSectionRenderer?.contents;
              if (items) {
                for (const item of items) {
                  if (item.videoRenderer) {
                    const video = item.videoRenderer;
                    videos.push({
                      title: video.title?.runs?.[0]?.text || 'Unknown',
                      url: `https://www.youtube.com/watch?v=${video.videoId}`,
                      thumbnail: video.thumbnail?.thumbnails?.[0]?.url || '',
                      duration: video.lengthText?.simpleText || 'N/A',
                      author: video.ownerText?.runs?.[0]?.text || 'Unknown'
                    });
                    if (videos.length >= 10) break;
                  }
                }
              }
              if (videos.length >= 10) break;
            }
          }
        }
        break;
      }
    }
    
    res.json(videos);
  } catch (error) {
    console.error('Search error:', error.message);
    res.json([]);
  }
});

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', (message) => {
    try {
      const messageStr = message.toString();
      console.log('Message received on server:', messageStr);
      const data = JSON.parse(messageStr);
      const { roomId, url, action, time, username, message: chatMessage } = data;

      if (!roomId) {
        console.error('❌ No roomId provided in message');
        return;
      }

      if (!rooms[roomId]) {
        console.log(`Creating new room: ${roomId}`);
        rooms[roomId] = { users: [], videoUrl: '', currentTime: 0, lastUpdate: 0 };
      } else {
        console.log(`Joining existing room: ${roomId}`);
      }

    const room = rooms[roomId];

    switch (action) {
      case 'join':
        // Prevent duplicate users
        if (!room.users.includes(ws)) {
          ws.roomId = roomId;
          room.users.push(ws);
          console.log(`✅ User joined room ${roomId}. Total users: ${room.users.length}`);
          
          // Notify all users in the room about the new user count
          room.users.forEach((user) => {
            if (user.readyState === WebSocket.OPEN) {
              user.send(JSON.stringify({ type: 'userCount', count: room.users.length }));
            }
          });
        }
        // Send current room state to the joining user
        if (room.videoUrl) {
          console.log(`Syncing video to new user: ${room.videoUrl} at ${room.currentTime}s`);
          ws.send(JSON.stringify({ type: 'sync', url: room.videoUrl, time: room.currentTime }));
        } else {
          ws.send(JSON.stringify({ type: 'sync', url: '', time: 0 }));
        }
        break;

      case 'play':
      case 'pause':
        room.currentTime = time;
        room.lastUpdate = Date.now();
        
        console.log(`${action} at ${time}s`);
        
        room.users.forEach((user) => {
          if (user !== ws && user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: action, time }));
          }
        });
        break;

      case 'seek':
        const seekNow = Date.now();
        if (seekNow - room.lastUpdate < 300) return;
        
        room.lastUpdate = seekNow;
        room.currentTime = time;

        room.users.forEach((user) => {
          if (user !== ws && user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: 'seek', time }));
          }
        });
        break;

      case 'changeUrl':
        room.videoUrl = url;
        room.currentTime = 0;
        room.lastUpdate = 0;
        console.log(`📹 Video changed in room ${roomId}: ${url}`);
        
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: 'changeUrl', url, time: 0 }));
          }
        });
        break;

      case 'chat':
        console.log(`💬 Chat in room ${roomId} from ${username}: ${chatMessage}`);
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ type: 'chat', username, message: chatMessage }));
          }
        });
        break;
    }
    } catch (error) {
      console.error('❌ Error processing message:', error.message);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    Object.keys(rooms).forEach((roomId) => {
      const room = rooms[roomId];
      room.users = room.users.filter((user) => user !== ws);
      console.log(`Room ${roomId} now has ${room.users.length} users`);
      
      // Notify remaining users about the user count change
      room.users.forEach((user) => {
        if (user.readyState === WebSocket.OPEN) {
          user.send(JSON.stringify({ type: 'userCount', count: room.users.length }));
        }
      });
    });
  });
});

server.listen(8080, () => {
  console.log('Server is running on port 8080');
});
