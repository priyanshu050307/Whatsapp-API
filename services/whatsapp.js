const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const config = require('../config/config');
const logger = require('./logger');
const socketService = require('./socketService');
const db = require('./db');

const sessions = new Map(); // tenantId -> session object

// Get or create session context
function getOrCreateSession(tenantId) {
  if (sessions.has(tenantId)) {
    return sessions.get(tenantId);
  }
  const session = {
    client: null,
    clientState: 'DISCONNECTED',
    qrCodeData: null,
    isExplicitLogout: false,
    clientInfo: {
      number: null,
      pushname: null,
      platform: null,
      wwebVersion: null
    },
    messageQueue: [],
    sendingQueue: [],
    isProcessingQueue: false,
    initUptime: null
  };
  sessions.set(tenantId, session);
  return session;
}

// Dynamic Chrome/Chromium path lookup for Windows & Linux environment compatibility
function getChromeExecutablePath() {
  const activeConfig = config.get();
  if (activeConfig.PUPPETEER_EXEC_PATH) {
    return activeConfig.PUPPETEER_EXEC_PATH;
  }

  if (process.platform === 'win32') {
    const winPaths = [
      path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe'),
      path.join(process.env.USERPROFILE || 'C:\\Users\\Admin', '.cache\\puppeteer\\chrome-headless-shell\\win64-146.0.7680.31\\chrome-headless-shell-win64\\chrome-headless-shell.exe'),
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Admin\\AppData\\Local', 'Google\\Chrome\\Application\\chrome.exe')
    ];
    for (const p of winPaths) {
      if (fs.existsSync(p)) {
        logger.info(`Auto-discovered Chrome binary at: ${p}`);
        return p;
      }
    }
  } else if (process.platform === 'linux') {
    const linuxPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(p)) {
        logger.info(`Auto-discovered Chrome binary at: ${p}`);
        return p;
      }
    }
  }
  
  return undefined;
}

// Initialize WhatsApp Web Client for a specific Tenant
function initClient(tenantId) {
  const session = getOrCreateSession(tenantId);
  if (session.client) {
    logger.info(`[Tenant: ${tenantId}] WhatsApp Client already exists. Skipping initialization.`);
    return;
  }
  
  session.isExplicitLogout = false;
  logger.info(`[Tenant: ${tenantId}] Initializing WhatsApp Web Client...`);
  session.clientState = 'CONNECTING';
  session.qrCodeData = null;
  socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'CONNECTING' });
  
  const activeConfig = config.get();
  const authPath = path.resolve(activeConfig.SESSION_PATH || './session', tenantId);
  
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const chromePath = getChromeExecutablePath();
  
  session.client = new Client({
    authStrategy: new LocalAuth({
      dataPath: authPath
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    },
    puppeteer: {
      headless: activeConfig.PUPPETEER_HEADLESS,
      executablePath: chromePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      ]
    }
  });

  // Event: QR Code generated
  session.client.on('qr', async (qr) => {
    session.clientState = 'DISCONNECTED';
    logger.info(`[Tenant: ${tenantId}] New WhatsApp QR Code generated. Scan to connect.`);
    try {
      session.qrCodeData = await qrcode.toDataURL(qr);
      socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'DISCONNECTED', qrCode: session.qrCodeData });
    } catch (err) {
      logger.error(`[Tenant: ${tenantId}] Failed to convert QR code to data URL: %s`, err.message);
    }
  });

  // Event: Loading screen
  session.client.on('loading_screen', (percent, message) => {
    if (session.clientState !== 'READY') {
      session.clientState = 'LOADING';
    }
    session.qrCodeData = null;
    logger.info(`[Tenant: ${tenantId}] Loading WhatsApp Web: ${percent}% - ${message}`);
    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'LOADING', percent, message });
  });

  // Event: Authenticated successfully
  session.client.on('authenticated', () => {
    session.clientState = 'AUTHENTICATING';
    session.qrCodeData = null;
    logger.info(`[Tenant: ${tenantId}] WhatsApp Authentication succeeded. Restoring session details...`);
    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'AUTHENTICATING' });
  });

  // Event: Authentication failure
  session.client.on('auth_failure', (msg) => {
    session.clientState = 'DISCONNECTED';
    session.qrCodeData = null;
    logger.error(`[Tenant: ${tenantId}] WhatsApp Authentication failed: %s`, msg);
    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'DISCONNECTED', error: msg });
  });

  // Event: Client Ready to send/receive messages
  session.client.on('ready', () => {
    session.clientState = 'READY';
    session.qrCodeData = null;
    session.initUptime = new Date();
    
    if (session.client.info) {
      session.clientInfo.number = session.client.info.me.user;
      session.clientInfo.pushname = session.client.info.pushname;
      session.clientInfo.platform = session.client.info.platform;
    }
    
    try {
      session.client.getWWebVersion().then(v => {
        session.clientInfo.wwebVersion = v;
        logger.info(`[Tenant: ${tenantId}] WhatsApp Web Engine version: ${v}`);
      });
    } catch (e) {
      logger.debug(`[Tenant: ${tenantId}] Could not retrieve WhatsApp Web version: %s`, e.message);
    }
    
    logger.info(`[Tenant: ${tenantId}] WhatsApp client is READY to send messages.`);
    socketService.emitToTenant(tenantId, 'whatsapp_status', {
      state: 'READY',
      number: session.clientInfo.number,
      pushname: session.clientInfo.pushname
    });

    // WhatsApp Web Store takes a few seconds to fully sync after ready event.
    // Emit delayed 'chat_sync' signals so the frontend knows to re-fetch chats.
    setTimeout(() => {
      if (sessions.get(tenantId)?.clientState === 'READY') {
        logger.info(`[Tenant: ${tenantId}] Emitting chat_sync signal (5s after ready)...`);
        socketService.emitToTenant(tenantId, 'whatsapp_chat_sync', { state: 'READY' });
      }
    }, 5000);

    setTimeout(() => {
      if (sessions.get(tenantId)?.clientState === 'READY') {
        logger.info(`[Tenant: ${tenantId}] Emitting chat_sync signal (12s after ready)...`);
        socketService.emitToTenant(tenantId, 'whatsapp_chat_sync', { state: 'READY' });
      }
    }, 12000);
  });

  // Event: Incoming / Outgoing Real-Time WhatsApp Message Listener
  session.client.on('message_create', async (msg) => {
    try {
      const isGroup = msg.from.endsWith('@g.us');
      const chatId = msg.fromMe ? msg.to : msg.from;
      
      const msgPayload = {
        id: msg.id._serialized,
        chatId: chatId,
        sender: msg.from,
        receiver: msg.to,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        hasMedia: msg.hasMedia,
        type: msg.type,
        pushname: msg._data?.notifyName || null
      };

      // Emit real-time message event ONLY to the authenticated tenant's socket room
      socketService.emitToTenant(tenantId, 'whatsapp_message', msgPayload);
    } catch (err) {
      logger.error(`[Tenant: ${tenantId}] Error processing real-time message_create event: %s`, err.message);
    }
  });

  // Event: Client disconnected
  session.client.on('disconnected', (reason) => {
    session.clientState = 'DISCONNECTED';
    session.qrCodeData = null;
    session.clientInfo = { number: null, pushname: null, platform: null, wwebVersion: null };
    logger.warn(`[Tenant: ${tenantId}] WhatsApp Client disconnected: %s`, reason);

    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'DISCONNECTED', reason });

    if (!session.isExplicitLogout) {
      destroyClient(tenantId).then(() => {
        logger.info(`[Tenant: ${tenantId}] Re-initializing WhatsApp Web client in 5 seconds...`);
        setTimeout(() => initClient(tenantId), 5000);
      });
    } else {
      destroyClient(tenantId, { isExplicitLogout: true });
    }
  });

  // Initialize client
  session.client.initialize().catch(err => {
    logger.error(`[Tenant: ${tenantId}] Failed to initialize WhatsApp Web client: %s`, err.message);
    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'DISCONNECTED', error: err.message });
    
    if (!session.isExplicitLogout) {
      destroyClient(tenantId).then(() => {
        logger.info(`[Tenant: ${tenantId}] Re-initializing failed client in 10 seconds...`);
        setTimeout(() => {
          if (sessions.has(tenantId) && !sessions.get(tenantId).isExplicitLogout) {
            initClient(tenantId);
          }
        }, 10000);
      });
    } else {
      destroyClient(tenantId, { isExplicitLogout: true });
    }
  });
}

// Destroy current WhatsApp client instance for a Tenant
async function destroyClient(tenantId, options = {}) {
  const session = sessions.get(tenantId);
  if (session) {
    if (options.isExplicitLogout) {
      session.isExplicitLogout = true;
    }
    if (session.client) {
      try {
        session.client.removeAllListeners();
        await session.client.destroy();
        logger.info(`[Tenant: ${tenantId}] WhatsApp Web Client instance successfully destroyed.`);
      } catch (err) {
        logger.error(`[Tenant: ${tenantId}] Error during client destruction: %s`, err.message);
      }
      session.client = null;
    }
    session.clientState = 'DISCONNECTED';
    session.qrCodeData = null;
    session.clientInfo = { number: null, pushname: null, platform: null, wwebVersion: null };
    socketService.emitToTenant(tenantId, 'whatsapp_status', { state: 'DISCONNECTED' });
  }
}

// Fetch live active WhatsApp chats list with multi-tiered fallback mechanism
async function getChats(tenantId) {
  const session = sessions.get(tenantId);
  if (!session || session.clientState !== 'READY' || !session.client) {
    logger.debug(`[Tenant: ${tenantId}] getChats(): session not ready. State: ${session ? session.clientState : 'no-session'}`);
    return [];
  }

  const chatMap = new Map();

  // Tier 1: Standard whatsapp-web.js getChats() with 8s timeout
  try {
    logger.debug(`[Tenant: ${tenantId}] getChats() Tier 1: calling client.getChats()...`);
    const rawChats = await Promise.race([
      session.client.getChats(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getChats timeout after 8s')), 8000))
    ]);

    if (rawChats && Array.isArray(rawChats) && rawChats.length > 0) {
      logger.info(`[Tenant: ${tenantId}] getChats() Tier 1 SUCCESS: ${rawChats.length} chats from client.getChats()`);
      rawChats.slice(0, 100).forEach(chat => {
        try {
          const id = (chat.id && chat.id._serialized) ? chat.id._serialized : (chat.id && chat.id.user ? `${chat.id.user}@c.us` : null);
          if (!id) return;
          chatMap.set(id, {
            id: id,
            name: chat.name || (chat.id && chat.id.user) || id,
            number: (chat.id && chat.id.user) || id.split('@')[0],
            unreadCount: chat.unreadCount || 0,
            timestamp: chat.timestamp || Math.floor(Date.now() / 1000),
            isGroup: chat.isGroup || false,
            profilePic: null,
            lastMessage: chat.lastMessage ? {
              body: chat.lastMessage.body || '',
              timestamp: chat.lastMessage.timestamp || Math.floor(Date.now() / 1000),
              fromMe: chat.lastMessage.fromMe || false
            } : null
          });
        } catch (chatErr) {
          logger.debug(`[Tenant: ${tenantId}] Error processing individual chat: ${chatErr.message}`);
        }
      });
    } else {
      logger.info(`[Tenant: ${tenantId}] getChats() Tier 1: client.getChats() returned 0 chats. Trying Tier 2...`);
    }
  } catch (err) {
    logger.info(`[Tenant: ${tenantId}] getChats() Tier 1 failed (${err.message}). Trying Tier 2...`);
  }

  // Tier 2: Direct WAWebCollections internal Store evaluation (correct access path)
  if (chatMap.size === 0 && session.client.pupPage) {
    try {
      logger.debug(`[Tenant: ${tenantId}] getChats() Tier 2: trying WAWebCollections.Chat.getModelsArray()...`);
      const storeChats = await session.client.pupPage.evaluate(() => {
        try {
          // The correct way to access chats in WhatsApp Web internal store
          const Chat = window.require('WAWebCollections').Chat;
          if (!Chat) return [];
          const models = Chat.getModelsArray ? Chat.getModelsArray() : (Chat.models || []);
          if (!models || models.length === 0) return [];
          return models.slice(0, 100).map(m => {
            try {
              const id = m.id ? (m.id._serialized || (m.id.user + '@' + (m.id.server || 'c.us'))) : null;
              if (!id) return null;
              const lastMsg = m.lastMessage || m.lastReceivedKey ? {
                body: (m.lastMessage && m.lastMessage.body) || '',
                timestamp: (m.lastMessage && (m.lastMessage.t || m.lastMessage.timestamp)) || Math.floor(Date.now() / 1000),
                fromMe: !!(m.lastMessage && m.lastMessage.id && m.lastMessage.id.fromMe)
              } : null;
              return {
                id: id,
                name: m.name || m.formattedTitle || (m.id && m.id.user) || id,
                number: (m.id && m.id.user) || id.split('@')[0],
                unreadCount: m.unreadCount || 0,
                timestamp: m.t || m.timestamp || Math.floor(Date.now() / 1000),
                isGroup: !!(m.id && m.id.server === 'g.us'),
                lastMessage: lastMsg
              };
            } catch (e) {
              return null;
            }
          }).filter(Boolean);
        } catch (e) {
          return [];
        }
      });

      if (storeChats && storeChats.length > 0) {
        logger.info(`[Tenant: ${tenantId}] getChats() Tier 2 SUCCESS: ${storeChats.length} chats from WAWebCollections`);
        storeChats.forEach(c => {
          if (c && c.id && !chatMap.has(c.id)) chatMap.set(c.id, c);
        });
      } else {
        logger.info(`[Tenant: ${tenantId}] getChats() Tier 2: WAWebCollections returned 0 chats. Trying Tier 3...`);
      }
    } catch (e) {
      logger.info(`[Tenant: ${tenantId}] getChats() Tier 2 failed (${e.message}). Trying Tier 3...`);
    }
  }

  // Tier 3: Extract rendered chats from WhatsApp Web DOM (#pane-side)
  if (chatMap.size === 0 && session.client.pupPage) {
    try {
      logger.debug(`[Tenant: ${tenantId}] getChats() Tier 3: scraping #pane-side DOM...`);
      const domChats = await session.client.pupPage.evaluate(() => {
        try {
          const items = document.querySelectorAll('#pane-side div[role="listitem"]');
          const results = [];
          items.forEach(item => {
            const titleEl = item.querySelector('span[title]');
            const name = titleEl ? titleEl.getAttribute('title') : null;
            if (name) {
              const clean = name.replace(/\D/g, '');
              const id = clean.length >= 7 ? `${clean}@c.us` : `${Date.now()}@c.us`;
              results.push({
                id: id,
                name: name,
                number: clean || name,
                unreadCount: 0,
                timestamp: Math.floor(Date.now() / 1000),
                isGroup: false,
                lastMessage: null
              });
            }
          });
          return results;
        } catch (e) {
          return [];
        }
      });

      if (domChats && domChats.length > 0) {
        logger.info(`[Tenant: ${tenantId}] getChats() Tier 3 SUCCESS: ${domChats.length} chats from DOM`);
        domChats.forEach(c => {
          if (!chatMap.has(c.id)) chatMap.set(c.id, c);
        });
      }
    } catch (e) {
      logger.debug(`[Tenant: ${tenantId}] getChats() Tier 3 DOM notice: ${e.message}`);
    }
  }

  // Tier 4: In-memory session message queue
  if (session.messageQueue && session.messageQueue.length > 0) {
    let addedFromQueue = 0;
    session.messageQueue.forEach(m => {
      if (m.chatId && !chatMap.has(m.chatId)) {
        chatMap.set(m.chatId, {
          id: m.chatId,
          name: m.pushname || m.sender || m.chatId.split('@')[0],
          number: m.chatId.split('@')[0],
          unreadCount: 0,
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
          isGroup: m.chatId.endsWith('@g.us'),
          lastMessage: { body: m.body || '', timestamp: m.timestamp || Math.floor(Date.now() / 1000), fromMe: m.fromMe || false }
        });
        addedFromQueue++;
      }
    });
    if (addedFromQueue > 0) {
      logger.info(`[Tenant: ${tenantId}] getChats() Tier 4: added ${addedFromQueue} chats from message queue`);
    }
  }

  // Tier 5: Database recent transmission logs fallback
  try {
    const recentLogs = await db.getLogs(tenantId, 50);
    if (recentLogs && recentLogs.length > 0) {
      let addedFromDB = 0;
      recentLogs.forEach(log => {
        if (log.mobile) {
          const clean = String(log.mobile).replace(/\D/g, '');
          const id = `${clean}@c.us`;
          if (!chatMap.has(id)) {
            chatMap.set(id, {
              id: id,
              name: `+${clean}`,
              number: clean,
              unreadCount: 0,
              timestamp: log.created_at ? Math.floor(new Date(log.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000),
              isGroup: false,
              lastMessage: { body: log.message || '', timestamp: Math.floor(Date.now() / 1000), fromMe: true }
            });
            addedFromDB++;
          }
        }
      });
      if (addedFromDB > 0) {
        logger.info(`[Tenant: ${tenantId}] getChats() Tier 5: added ${addedFromDB} chats from DB logs`);
      }
    }
  } catch (e) {
    logger.debug(`[Tenant: ${tenantId}] getChats() Tier 5 DB notice: ${e.message}`);
  }

  const result = Array.from(chatMap.values());
  logger.info(`[Tenant: ${tenantId}] getChats() TOTAL: ${result.length} chats returned`);
  return result;
}

// Fetch messages for a specific chat ID with fallback
async function getChatMessages(tenantId, chatId, limit = 50) {
  const session = sessions.get(tenantId);
  if (!session || session.clientState !== 'READY' || !session.client) {
    return [];
  }

  const formattedChatId = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@c.us`;

  // Primary: Try getChatById + fetchMessages
  try {
    const chat = await Promise.race([
      session.client.getChatById(formattedChatId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getChatById timeout after 8s')), 8000))
    ]);
    if (chat) {
      const messages = await Promise.race([
        chat.fetchMessages({ limit }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('fetchMessages timeout after 10s')), 10000))
      ]);
      logger.info(`[Tenant: ${tenantId}] getChatMessages() SUCCESS: ${messages.length} messages for ${formattedChatId}`);
      return messages.map(msg => ({
        id: msg.id ? msg.id._serialized : `msg_${Date.now()}`,
        chatId: formattedChatId,
        sender: msg.from || formattedChatId,
        receiver: msg.to || '',
        body: msg.body || '',
        fromMe: msg.fromMe || false,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        hasMedia: msg.hasMedia || false,
        type: msg.type || 'chat'
      }));
    }
  } catch (err) {
    logger.warn(`[Tenant: ${tenantId}] getChatMessages() primary failed for ${formattedChatId}: ${err.message || JSON.stringify(err)}`);
  }

  // Fallback: Try Puppeteer WAWebCollections evaluation for messages
  if (session.client.pupPage) {
    try {
      const storeMessages = await session.client.pupPage.evaluate(async (cid, lim) => {
        try {
          const Chat = window.require('WAWebCollections').Chat;
          if (!Chat) return [];

          let chat;
          try {
            const createWid = window.require('WAWebWidFactory')?.createWid;
            const wid = createWid ? createWid(cid) : null;
            if (wid) chat = Chat.get(wid);
          } catch (e) {}

          if (!chat) {
            const models = Chat.getModelsArray ? Chat.getModelsArray() : (Chat.models || []);
            const cleanId = cid.split('@')[0];
            chat = models.find(m => m.id && (m.id._serialized === cid || (m.id.user && m.id.user === cleanId)));
          }
          if (!chat) return [];

          if (chat.fetchMessages) {
            try {
              await chat.fetchMessages({ limit: lim });
            } catch (e) {}
          }

          const msgModels = chat.msgs && chat.msgs.models ? chat.msgs.models : (Array.isArray(chat.msgs) ? chat.msgs : []);
          if (!msgModels || msgModels.length === 0) return [];

          return msgModels.slice(-lim).map(m => ({
            id: (m.id && m.id._serialized) ? m.id._serialized : String(m.id || Date.now()),
            chatId: cid,
            sender: (m.id && m.id.remote) ? (m.id.remote._serialized || String(m.id.remote)) : cid,
            receiver: '',
            body: m.body || m.caption || '',
            fromMe: !!(m.id && m.id.fromMe),
            timestamp: m.t || m.timestamp || Math.floor(Date.now() / 1000),
            hasMedia: !!(m.mediaKey),
            type: m.type || 'chat'
          }));
        } catch (e) {
          return [];
        }
      }, formattedChatId, limit);

      if (storeMessages && storeMessages.length > 0) {
        logger.info(`[Tenant: ${tenantId}] getChatMessages() Store fallback: ${storeMessages.length} messages for ${formattedChatId}`);
        return storeMessages;
      }
    } catch (storeErr) {
      logger.debug(`[Tenant: ${tenantId}] getChatMessages() Store fallback failed: ${storeErr.message}`);
    }
  }

  // Final fallback: Return matching cached messages from session.messageQueue
  if (session.messageQueue && session.messageQueue.length > 0) {
    const queueMessages = session.messageQueue
      .filter(m => m.chatId === formattedChatId || m.receiver === formattedChatId || m.sender === formattedChatId)
      .slice(0, limit);
    if (queueMessages.length > 0) {
      logger.info(`[Tenant: ${tenantId}] getChatMessages() queue fallback: ${queueMessages.length} messages`);
    }
    return queueMessages;
  }

  return [];
}

// Send message to specific chat ID
async function sendMessageToChat(tenantId, chatId, body, file = null) {
  const session = sessions.get(tenantId);
  if (!session || session.clientState !== 'READY' || !session.client) {
    throw new Error(`WhatsApp client not connected for tenant ${tenantId}`);
  }

  const formattedChatId = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@c.us`;

  let response;
  if (file) {
    const base64Data = file.buffer.toString('base64');
    const media = new MessageMedia(file.mimetype, base64Data, file.originalname);
    response = await session.client.sendMessage(formattedChatId, media);
    if (body) {
      await session.client.sendMessage(formattedChatId, body);
    }
  } else {
    response = await session.client.sendMessage(formattedChatId, body);
  }

  const msgId = (response && response.id) 
    ? (typeof response.id === 'object' ? (response.id._serialized || response.id.id) : String(response.id))
    : `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const msgPayload = {
    id: msgId,
    chatId: formattedChatId,
    sender: session.clientInfo.number || 'me',
    receiver: formattedChatId,
    body: body || (file ? file.originalname : ''),
    fromMe: true,
    timestamp: (response && response.timestamp) ? response.timestamp : Math.floor(Date.now() / 1000)
  };

  // Cache in session message queue
  if (!session.messageQueue) session.messageQueue = [];
  session.messageQueue.unshift(msgPayload);

  // Deduct 1 credit & log message
  await db.deductCredit(tenantId);
  await db.logMessage(tenantId, formattedChatId.replace('@c.us', ''), body || 'Media Attachment', 'success');

  // Emit real-time message event to tenant room
  socketService.emitToTenant(tenantId, 'whatsapp_message', msgPayload);

  return msgPayload;
}

// Mark chat as read / seen
async function markChatAsRead(tenantId, chatId) {
  const session = sessions.get(tenantId);
  if (session && session.clientState === 'READY' && session.client) {
    try {
      const formattedChatId = chatId.includes('@') ? chatId : `${chatId.replace(/\D/g, '')}@c.us`;
      const chat = await session.client.getChatById(formattedChatId);
      if (chat && chat.sendSeen) {
        await chat.sendSeen();
        return true;
      }
    } catch (e) {
      logger.error(`[Tenant: ${tenantId}] Failed to mark chat ${chatId} as read: %s`, e.message);
    }
  }
  return false;
}

// Send legacy API message with queue tracking (asynchronous background queue)
async function sendWhatsAppMessage(tenantId, to, message, file = null) {
  const session = sessions.get(tenantId);
  if (!session || session.clientState !== 'READY' || !session.client) {
    throw new Error(`WhatsApp client not ready for tenant ${tenantId}. Current Status: ${session ? session.clientState : 'DISCONNECTED'}`);
  }

  const standardizedMobile = to.replace(/[^0-9]/g, '');
  const queueItem = { to, message, file, standardizedMobile, logId: null };
  session.sendingQueue.push(queueItem);

  // Start processing queue if not running
  triggerQueueProcessor(tenantId);

  // Return a mock successful response structure immediately with queueItem reference
  return {
    id: {
      _serialized: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
    },
    timestamp: Math.floor(Date.now() / 1000),
    queueItem: queueItem
  };
}

async function enqueueMessage(tenantId, to, message, file = null, standardizedMobile) {
  const session = sessions.get(tenantId);
  if (!session) {
    throw new Error(`WhatsApp session not found for tenant ${tenantId}`);
  }

  // Push to queue
  session.sendingQueue.push({ to, message, file, standardizedMobile });

  // Start processing queue if not running
  triggerQueueProcessor(tenantId);
}

async function triggerQueueProcessor(tenantId) {
  const session = sessions.get(tenantId);
  if (!session || session.isProcessingQueue) return;

  session.isProcessingQueue = true;

  // Process items sequentially in background
  (async () => {
    try {
      while (session.sendingQueue && session.sendingQueue.length > 0) {
        // Stop if client is disconnected
        if (session.clientState !== 'READY' || !session.client) {
          logger.warn(`[Tenant: ${tenantId}] Queue processor paused - WhatsApp client not ready (Status: ${session.clientState})`);
          break;
        }

        const task = session.sendingQueue[0]; // peek
        
        try {
          let formattedTo = task.to.includes('@') ? task.to : `${task.to.replace(/[^0-9]/g, '')}@c.us`;
          let response;
          
          if (task.file) {
            const base64Data = task.file.buffer.toString('base64');
            const media = new MessageMedia(task.file.mimetype, base64Data, task.file.originalname);
            response = await session.client.sendMessage(formattedTo, media);
            if (task.message) {
              await session.client.sendMessage(formattedTo, task.message);
            }
          } else {
            response = await session.client.sendMessage(formattedTo, task.message);
          }

          // Filter out the completed task
          session.sendingQueue.shift();

          const msgId = (response && response.id) 
            ? (typeof response.id === 'object' ? (response.id._serialized || response.id.id) : String(response.id))
            : `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

          // Log success to DB (only if not pre-logged)
          if (!task.logId) {
            await logService.logWhatsAppMessage(tenantId, task.standardizedMobile, task.message, 'success');
          }

          // Emit real-time socket event for outgoing message
          socketService.emitToTenant(tenantId, 'whatsapp_message', {
            id: msgId,
            chatId: formattedTo,
            sender: session.clientInfo.number || 'me',
            receiver: formattedTo,
            body: task.message,
            fromMe: true,
            timestamp: (response && response.timestamp) ? response.timestamp : Math.floor(Date.now() / 1000)
          });

        } catch (err) {
          // Task failed, shift it off the queue
          session.sendingQueue.shift();

          logger.error(`[Tenant: ${tenantId}] Failed to send background message to ${task.to}: %s`, err.message);
          
          // Log failure (update existing log or create new one)
          if (task.logId) {
            await logService.updateLogStatus(task.logId, 'failed', err.message);
          } else {
            await logService.logWhatsAppMessage(tenantId, task.standardizedMobile, task.message, 'failed', err.message);
          }
          
          // Refund credits upon failure (refund 2 if both file and message caption existed, otherwise 1)
          const refundAmount = task.deductedCredits || ((task.file && task.message) ? 2 : 1);
          try {
            await db.addCredits(tenantId, refundAmount, 'Auto-refund for failed transmission');
          } catch (refundErr) {
            logger.error(`[Tenant: ${tenantId}] Failed to auto-refund credit: %s`, refundErr.message);
          }
        }

        // Add a natural delay (between 500ms and 1500ms) to emulate human typing and bypass spam detection
        const naturalDelay = Math.floor(Math.random() * 1000) + 500;
        await new Promise(resolve => setTimeout(resolve, naturalDelay));
      }
    } finally {
      session.isProcessingQueue = false;
    }
  })();
}

// Logout session
async function logoutSession(tenantId) {
  const session = sessions.get(tenantId);
  if (session) {
    session.isExplicitLogout = true;
    if (session.client) {
      try {
        session.client.removeAllListeners();
        await session.client.logout();
        logger.info(`[Tenant: ${tenantId}] WhatsApp session logged out by user request.`);
      } catch (err) {
        logger.error(`[Tenant: ${tenantId}] Error logging out WhatsApp session: %s`, err.message);
      }
    }
  }

  await destroyClient(tenantId, { isExplicitLogout: true });

  const activeConfig = config.get();
  const authPath = path.resolve(activeConfig.SESSION_PATH || './session', tenantId);
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      logger.info(`[Tenant: ${tenantId}] Deleted session storage directory on logout: ${authPath}`);
    } catch (err) {
      logger.error(`[Tenant: ${tenantId}] Failed to delete session storage directory on logout: %s`, err.message);
    }
  }

  return true;
}

// Delete session storage data
async function deleteSessionData(tenantId) {
  logger.info(`[Tenant: ${tenantId}] Permanently deleting WhatsApp session and disk storage...`);
  await destroyClient(tenantId, { isExplicitLogout: true });
  sessions.delete(tenantId);

  const activeConfig = config.get();
  const authPath = path.resolve(activeConfig.SESSION_PATH || './session', tenantId);
  if (fs.existsSync(authPath)) {
    try {
      fs.rmSync(authPath, { recursive: true, force: true });
      logger.info(`[Tenant: ${tenantId}] Deleted session storage directory: ${authPath}`);
    } catch (err) {
      logger.error(`[Tenant: ${tenantId}] Failed to delete session storage directory: %s`, err.message);
    }
  }

  // Delete local fallback logs if any
  const fallbackLogPath = path.join(__dirname, `../logs/messages_${tenantId}.jsonl`);
  if (fs.existsSync(fallbackLogPath)) {
    try {
      fs.unlinkSync(fallbackLogPath);
      logger.info(`[Tenant: ${tenantId}] Deleted fallback log file: ${fallbackLogPath}`);
    } catch (err) {
      logger.error(`[Tenant: ${tenantId}] Failed to delete fallback log file: %s`, err.message);
    }
  }
}

// Restart client
async function restartClient(tenantId) {
  logger.info(`[Tenant: ${tenantId}] WhatsApp client restart requested.`);
  await destroyClient(tenantId);
  initClient(tenantId);
}

// Initialize tenants lazily on startup
async function initAllClients(tenants) {
  logger.info(`Checking saved WhatsApp sessions for ${tenants.length} tenants on startup...`);
  const activeConfig = config.get();
  for (const tenant of tenants) {
    try {
      const authPath = path.resolve(activeConfig.SESSION_PATH || './session', tenant.tenant_id);
      if (fs.existsSync(authPath) && fs.readdirSync(authPath).length > 0) {
        initClient(tenant.tenant_id);
      } else {
        getOrCreateSession(tenant.tenant_id);
      }
    } catch (err) {
      logger.error(`Failed during startup initialization check for tenant ${tenant.tenant_id}: %s`, err.message);
    }
  }
}

module.exports = {
  initClient,
  destroyClient,
  getOrCreateSession,
  getChats,
  getChatMessages,
  sendMessageToChat,
  markChatAsRead,
  sendWhatsAppMessage,
  enqueueMessage,
  logoutSession,
  deleteSessionData,
  restartClient,
  initAllClients,
  getClientState: (tenantId) => sessions.get(tenantId) ? sessions.get(tenantId).clientState : 'DISCONNECTED',
  getQrCodeData: (tenantId) => sessions.get(tenantId) ? sessions.get(tenantId).qrCodeData : null,
  getClientInfo: (tenantId) => sessions.get(tenantId) ? sessions.get(tenantId).clientInfo : { number: null, pushname: null, platform: null, wwebVersion: null },
  getQueueLength: (tenantId) => sessions.get(tenantId) ? (sessions.get(tenantId).sendingQueue?.length || 0) : 0,
  getUptime: (tenantId) => {
    const session = sessions.get(tenantId);
    return session && session.initUptime ? Math.floor((new Date() - session.initUptime) / 1000) : 0;
  }
};
