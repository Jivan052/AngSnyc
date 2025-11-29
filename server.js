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
      const { roomId, url, action, time, username, message: chatMessage, messageId, newMessage, audioData, duration, emoji, to, from, type, offer, answer, candidate } = data;

      if (!roomId) {
        console.error('No roomId provided in message');
        return;
      }

      if (!rooms[roomId]) {
        console.log(`Creating new room: ${roomId}`);
        rooms[roomId] = { users: [], videoUrl: '', currentTime: 0, lastUpdate: 0, reactions: {}, callParticipants: [] };
      } else {
        console.log(`Joining existing room: ${roomId}`);
      }

    const room = rooms[roomId];

    switch (action) {
      case 'join':
        // Prevent duplicate users
        if (!room.users.includes(ws)) {
          ws.roomId = roomId;
          ws.username = username;
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
        const chatData = { type: 'chat', username, message: chatMessage, messageId };
        if (data.replyTo) {
          chatData.replyTo = data.replyTo;
        }
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify(chatData));
          }
        });
        break;
      
      case 'mediaMessage':
        console.log(`📷 Media message in room ${roomId} from ${username}: ${data.mediaType}`);
        const mediaData = { 
          type: 'mediaMessage', 
          username, 
          message: chatMessage, 
          messageId,
          mediaType: data.mediaType,
          mediaData: data.mediaData,
          filename: data.filename
        };
        if (data.replyTo) {
          mediaData.replyTo = data.replyTo;
        }
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify(mediaData));
          }
        });
        break;
      
      case 'editChat':
        console.log(`✏️ Edit in room ${roomId} - Message ID: ${messageId}`);
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ 
              type: 'editChat', 
              username, 
              message: newMessage,
              messageId 
            }));
          }
        });
        break;
      
      case 'deleteMessage':
        console.log(`🗑️ Delete in room ${roomId} - Message ID: ${messageId}`);
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({ 
              type: 'deleteMessage',
              messageId 
            }));
          }
        });
        break;
      
      case 'voiceNote':
        console.log(`🎤 Voice note in room ${roomId} from ${username} - Duration: ${duration}s`);
        const voiceData = {
          type: 'voiceNote',
          username,
          audioData,
          duration,
          messageId
        };
        if (data.replyTo) {
          voiceData.replyTo = data.replyTo;
        }
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify(voiceData));
          }
        });
        break;
      
      case 'reaction':
        console.log(`👍 Reaction in room ${roomId} - ${emoji} on message ${messageId} by ${username}`);
        if (!room.reactions[messageId]) {
          room.reactions[messageId] = {};
        }
        if (!room.reactions[messageId][emoji]) {
          room.reactions[messageId][emoji] = [];
        }
        if (!room.reactions[messageId][emoji].includes(username)) {
          room.reactions[messageId][emoji].push(username);
        }
        
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'reaction',
              messageId,
              reactions: room.reactions[messageId]
            }));
          }
        });
        break;
      
      case 'removeReaction':
        console.log(`👎 Remove reaction in room ${roomId} - ${emoji} on message ${messageId} by ${username}`);
        if (room.reactions[messageId] && room.reactions[messageId][emoji]) {
          room.reactions[messageId][emoji] = room.reactions[messageId][emoji].filter(u => u !== username);
          if (room.reactions[messageId][emoji].length === 0) {
            delete room.reactions[messageId][emoji];
          }
          if (Object.keys(room.reactions[messageId]).length === 0) {
            delete room.reactions[messageId];
          }
        }
        
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'reaction',
              messageId,
              reactions: room.reactions[messageId] || {}
            }));
          }
        });
        break;
      
      case 'joinCall':
        console.log(`📞 ${username} joined voice call in room ${roomId}`);
        if (!room.callParticipants.includes(username)) {
          room.callParticipants.push(username);
        }
        
        // Notify all users in room
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'userJoinedCall',
              username,
              participants: room.callParticipants
            }));
          }
        });
        break;
      
      case 'leaveCall':
        console.log(`📞 ${username} left voice call in room ${roomId}`);
        room.callParticipants = room.callParticipants.filter(u => u !== username);
        
        // Notify all users in room
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'userLeftCall',
              username,
              participants: room.callParticipants
            }));
          }
        });
        break;
      
      case 'callSignal':
        console.log(`🔊 Call signal from ${from} to ${to} in room ${roomId}`);
        // Forward signaling data to specific user
        room.users.forEach((user) => {
          if (user.username === to && user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'callSignal',
              from,
              to,
              ...data
            }));
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
      
      // Remove user from call participants if they were in a call
      if (ws.username && room.callParticipants.includes(ws.username)) {
        room.callParticipants = room.callParticipants.filter(u => u !== ws.username);
        
        // Notify remaining users that this user left the call
        room.users.forEach((user) => {
          if (user.readyState === WebSocket.OPEN) {
            user.send(JSON.stringify({
              type: 'userLeftCall',
              username: ws.username,
              participants: room.callParticipants
            }));
          }
        });
      }
      
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
