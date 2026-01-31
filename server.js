// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Хранилище пользователей и сообщений
const users = new Map(); // userId -> WebSocket
const activeUsers = new Map(); // userId -> {userData, lastSeen}
const messages = new Map(); // chatId -> [messages]

// Middleware для CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Отдача статики (если нужно раздавать клиент)
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    onlineUsers: activeUsers.size,
    uptime: process.uptime()
  });
});

// API для проверки пользователя
app.get('/api/user/:userId', (req, res) => {
  const userId = req.params.userId;
  const userData = activeUsers.get(userId);
  
  if (userData) {
    res.json({
      exists: true,
      online: true,
      userData: userData.userData
    });
  } else {
    res.json({
      exists: false,
      online: false
    });
  }
});

// WebSocket обработка
wss.on('connection', (ws, req) => {
  console.log('✅ Новое WebSocket подключение');
  
  // Отправляем приветственное сообщение
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Добро пожаловать в Flip Chat!'
  }));
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      handleMessage(ws, message);
    } catch (error) {
      console.error('❌ Ошибка парсинга сообщения:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Неверный формат сообщения'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket отключение');
    
    // Находим пользователя и удаляем его
    for (const [userId, userWs] of users.entries()) {
      if (userWs === ws) {
        users.delete(userId);
        activeUsers.delete(userId);
        console.log(`👋 Пользователь ${userId} отключился`);
        
        // Уведомляем всех о выходе пользователя
        broadcast({
          type: 'user_offline',
          userId: userId
        });
        
        broadcastUserList();
        break;
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('⚠️ WebSocket ошибка:', error);
  });
});

// Обработка сообщений от клиентов
function handleMessage(ws, message) {
  console.log('📨 Получено сообщение:', message.type);
  
  switch (message.type) {
    case 'register':
      handleRegister(ws, message);
      break;
      
    case 'private_message':
      handlePrivateMessage(ws, message);
      break;
      
    case 'typing':
      handleTyping(ws, message);
      break;
      
    case 'get_online_users':
      sendOnlineUsers(ws);
      break;
      
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
      
    default:
      console.log('❓ Неизвестный тип сообщения:', message.type);
  }
}

// Регистрация пользователя
function handleRegister(ws, message) {
  const { userId, userData } = message;
  
  if (!userId) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Не указан userId'
    }));
    return;
  }
  
  // Сохраняем пользователя
  users.set(userId, ws);
  activeUsers.set(userId, {
    userData: userData || {},
    lastSeen: Date.now(),
    status: 'online'
  });
  
  ws.userId = userId;
  
  console.log(`👤 Зарегистрирован пользователь: ${userId}`);
  
  // Отправляем подтверждение
  ws.send(JSON.stringify({
    type: 'registered',
    userId: userId,
    timestamp: Date.now()
  }));
  
  // Уведомляем всех о новом пользователе
  broadcast({
    type: 'user_online',
    userId: userId,
    userData: userData || {}
  });
  
  // Отправляем обновленный список пользователей
  broadcastUserList();
}

// Приватное сообщение
function handlePrivateMessage(ws, message) {
  const { from, to, text, messageId, timestamp } = message;
  
  if (!from || !to || !text) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Не указаны from, to или text'
    }));
    return;
  }
  
  // Сохраняем сообщение в историю
  const chatId = [from, to].sort().join('_');
  if (!messages.has(chatId)) {
    messages.set(chatId, []);
  }
  
  const messageObj = {
    from: from,
    to: to,
    text: text,
    messageId: messageId || Date.now() + '_' + Math.random().toString(36).substr(2, 9),
    timestamp: timestamp || Date.now()
  };
  
  messages.get(chatId).push(messageObj);
  
  // Ограничиваем историю (последние 100 сообщений)
  const chatMessages = messages.get(chatId);
  if (chatMessages.length > 100) {
    messages.set(chatId, chatMessages.slice(-100));
  }
  
  // Отправляем получателю
  const recipient = users.get(to);
  if (recipient) {
    recipient.send(JSON.stringify({
      type: 'private_message',
      from: from,
      text: text,
      messageId: messageObj.messageId,
      timestamp: messageObj.timestamp
    }));
    
    console.log(`📤 Сообщение от ${from} к ${to}: ${text.substring(0, 50)}...`);
    
    // Подтверждение отправителю
    ws.send(JSON.stringify({
      type: 'message_delivered',
      to: to,
      messageId: messageObj.messageId,
      timestamp: Date.now()
    }));
  } else {
    // Получатель не в сети
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Пользователь не в сети'
    }));
  }
}

// Индикатор набора текста
function handleTyping(ws, message) {
  const { from, to, isTyping, chatId } = message;
  
  if (!from || !to) {
    return;
  }
  
  const recipient = users.get(to);
  if (recipient) {
    recipient.send(JSON.stringify({
      type: 'typing',
      from: from,
      isTyping: isTyping,
      chatId: chatId
    }));
  }
}

// Отправка списка онлайн пользователей
function sendOnlineUsers(ws) {
  const usersList = Array.from(activeUsers.entries()).map(([userId, data]) => ({
    userId: userId,
    userData: data.userData,
    lastSeen: data.lastSeen,
    status: data.status
  }));
  
  ws.send(JSON.stringify({
    type: 'online_users',
    users: usersList
  }));
}

// Broadcast сообщения всем подключенным
function broadcast(data) {
  const message = JSON.stringify(data);
  users.forEach(userWs => {
    if (userWs.readyState === WebSocket.OPEN) {
      userWs.send(message);
    }
  });
}

// Broadcast списка пользователей
function broadcastUserList() {
  const usersList = Array.from(activeUsers.entries()).map(([userId, data]) => ({
    userId: userId,
    userData: data.userData,
    lastSeen: data.lastSeen,
    status: data.status
  }));
  
  broadcast({
    type: 'online_users',
    users: usersList
  });
}

// Периодическая очистка неактивных пользователей
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 минут
  
  for (const [userId, data] of activeUsers.entries()) {
    if (now - data.lastSeen > timeout) {
      const ws = users.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Отправляем ping для проверки
        ws.send(JSON.stringify({ type: 'ping', timestamp: now }));
      } else {
        // Удаляем неактивного пользователя
        users.delete(userId);
        activeUsers.delete(userId);
        console.log(`🚮 Удален неактивный пользователь: ${userId}`);
      }
    }
  }
}, 60000); // Каждую минуту

// Запуск сервера
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🔗 WebSocket: wss://ваше-приложение.onrender.com`);
  console.log(`🩺 Health check: http://localhost:${PORT}/health`);
});
