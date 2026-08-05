/**
 * WhatsApp Multi-Tenant REST Gateway, Admin Portal & Live WhatsApp Web Frontend Logic
 */

let state = {
  token: localStorage.getItem('wa_gateway_token') || null,
  isAdmin: localStorage.getItem('wa_gateway_is_admin') === 'true',
  tenant: null,
  pollTimer: null,
  chatPollTimer: null,
  socket: null,
  adminClients: [],
  waChats: [],
  activeChatId: null,
  activeChatName: null,
  waStatus: 'DISCONNECTED'
};

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

function initApp() {
  setupEventListeners();
  initGoogleAuth();

  // Check if requesting the admin portal link
  const isAdminUrl = window.location.pathname === '/admin' || window.location.hash === '#admin' || window.location.hash === '#admin-login';

  if (state.token) {
    if (isAdminUrl) {
      if (state.isAdmin) {
        showAdminDashboard();
      } else {
        // Logged in as client, but requesting admin URL -> show admin login screen
        showAuthOverlay();
      }
    } else {
      if (state.isAdmin) {
        showAdminDashboard();
      } else {
        showClientDashboard();
      }
    }
  } else {
    showAuthOverlay();
  }
}

/* ==================== AUTHENTICATION & LOGIN LOGIC ==================== */

let firebaseInitialized = false;

function decodeJwtPayload(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload);
  } catch (e) {
    return null;
  }
}

async function initGoogleAuth() {
  const loginBtn = document.getElementById('btnFirebaseGoogleLogin');
  if (!loginBtn) return;

  // Set click handler
  loginBtn.onclick = async (e) => {
    e.preventDefault();
    await signInWithFirebaseGoogle();
  };

  try {
    // 1. Fetch Firebase config from backend
    const res = await fetch('/api/auth/firebase-config');
    const data = await res.json();
    if (data.status === 'success' && data.config) {
      if (!firebaseInitialized) {
        firebase.initializeApp(data.config);
        firebaseInitialized = true;
      }
    } else {
      console.error('Failed to retrieve Firebase configuration from server');
    }
  } catch (err) {
    console.error('Error fetching Firebase config:', err);
  }
}

async function signInWithFirebaseGoogle() {
  const isMock = !firebaseInitialized || !firebase.app().options.apiKey || firebase.app().options.apiKey.startsWith('mock');

  if (isMock) {
    // FALLBACK: Mock Google Sign-In Mode for easy local development / testing
    const email = prompt('Enter your Gmail address to simulate Google Sign-in (Firebase Mock Mode):', 'testuser@gmail.com');
    if (!email) return;

    if (!email.includes('@')) {
      alert('Please enter a valid email address.');
      return;
    }

    const name = email.split('@')[0];
    const picture = 'https://www.gravatar.com/avatar/' + Math.random().toString(36).substring(7) + '?d=identicon';
    const googleId = 'google_' + Math.floor(Math.random() * 1000000000);

    const loginBtn = document.getElementById('btnFirebaseGoogleLogin');
    const originalHtml = loginBtn.innerHTML;
    loginBtn.disabled = true;
    loginBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Mock Authenticating...';

    try {
      await performGoogleLogin({
        email: email,
        name: name,
        picture: picture,
        googleId: googleId
      });
    } finally {
      loginBtn.disabled = false;
      loginBtn.innerHTML = originalHtml;
    }
    return;
  }
  
  clearAuthAlert('clientAuthAlert');
  const loginBtn = document.getElementById('btnFirebaseGoogleLogin');
  const originalHtml = loginBtn.innerHTML;
  loginBtn.disabled = true;
  loginBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Connecting to Google...';

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await firebase.auth().signInWithPopup(provider);
    const user = result.user;
    const idToken = await user.getIdToken();

    // Pass details to backend
    await performGoogleLogin({
      idToken: idToken,
      email: user.email,
      name: user.displayName,
      picture: user.photoURL,
      googleId: user.uid
    });
  } catch (err) {
    console.error('Firebase Auth Popup Error:', err);
    let errorMsg = err.message || 'Google Sign-in failed. Please try again.';
    if (err.code === 'auth/popup-closed-by-user') {
      errorMsg = 'Login window closed. Please complete the Google sign-in details inside the popup window.';
    }
    showAuthAlert('clientAuthAlert', errorMsg);
  } finally {
    loginBtn.disabled = false;
    loginBtn.innerHTML = originalHtml;
  }
}

function showAuthAlert(alertId, message, type = 'danger') {
  const el = document.getElementById(alertId);
  if (!el) return;
  el.className = `alert alert-${type} border-${type} border-opacity-30 bg-${type} bg-opacity-10 text-${type}-emphasis fs-7 py-2.5 px-3 rounded-3 mb-3 d-flex align-items-center gap-2`;
  el.innerHTML = `<i class="bi bi-exclamation-triangle-fill flex-shrink-0"></i> <div>${escapeHtml(message)}</div>`;
  el.classList.remove('d-none');
}

function clearAuthAlert(alertId) {
  const el = document.getElementById(alertId);
  if (el) {
    el.classList.add('d-none');
    el.innerHTML = '';
  }
}

async function performGoogleLogin(payload) {
  clearAuthAlert('clientAuthAlert');
  const btn = document.getElementById('btnQuickGmailSubmit');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Authenticating...';
  }

  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (data.status === 'success' && data.token) {
      state.token = data.token;
      state.isAdmin = false;
      state.tenant = data.tenant;
      localStorage.setItem('wa_gateway_token', data.token);
      localStorage.setItem('wa_gateway_is_admin', 'false');

      showClientDashboard();
    } else {
      showAuthAlert('clientAuthAlert', 'Google Login Failed: ' + (data.reason || 'Unknown authentication error'));
    }
  } catch (err) {
    showAuthAlert('clientAuthAlert', 'Failed to connect to authentication server: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-google me-1"></i> Continue with Google Account';
    }
  }
}

async function performAdminLogin(password) {
  clearAuthAlert('adminAuthAlert');
  const btn = document.getElementById('btnAdminLoginSubmit');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Verifying Credentials...';
  }

  try {
    const res = await fetch('/api/auth/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const data = await res.json();

    if (data.status === 'success' && data.token) {
      state.token = data.token;
      state.isAdmin = true;
      localStorage.setItem('wa_gateway_token', data.token);
      localStorage.setItem('wa_gateway_is_admin', 'true');

      showAdminDashboard();
    } else {
      showAuthAlert('adminAuthAlert', 'Admin Authentication Failed: ' + (data.reason || 'Invalid master password'));
    }
  } catch (err) {
    showAuthAlert('adminAuthAlert', 'Failed to connect to authentication server: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-shield-fill-check me-1"></i> Access Master Admin Portal';
    }
  }
}

function logout() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.chatPollTimer) clearInterval(state.chatPollTimer);
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  state.token = null;
  state.isAdmin = false;
  state.tenant = null;
  state.activeChatId = null;
  state.waChats = [];
  state.waStatus = 'DISCONNECTED';
  localStorage.removeItem('wa_gateway_token');
  localStorage.removeItem('wa_gateway_is_admin');
  showAuthOverlay();
}

function showAuthOverlay() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
  
  // Show the landing page by default
  const landingPage = document.getElementById('landingPage');
  if (landingPage) landingPage.style.display = 'block';

  document.getElementById('mainApp').style.display = 'none';

  // Toggle admin/client login view based on the URL path or hash
  const clientLoginView = document.getElementById('clientLoginView');
  const adminLoginView = document.getElementById('adminLoginView');
  if (clientLoginView && adminLoginView) {
    const isAdminUrl = window.location.pathname === '/admin' || window.location.hash === '#admin' || window.location.hash === '#admin-login';
    if (isAdminUrl) {
      document.getElementById('authOverlay').style.display = 'flex';
      clientLoginView.style.display = 'none';
      adminLoginView.style.display = 'block';
    } else {
      document.getElementById('authOverlay').style.display = 'none';
      clientLoginView.style.display = 'block';
      adminLoginView.style.display = 'none';
    }
  }
}

function openLoginOverlay() {
  document.getElementById('authOverlay').style.display = 'flex';
}

function closeLoginOverlay() {
  document.getElementById('authOverlay').style.display = 'none';
}

function handleContactSubmit(event) {
  event.preventDefault();
  const resultDiv = document.getElementById('contactFormResult');
  if (resultDiv) {
    resultDiv.innerHTML = '<span class="text-success fs-7 fw-semibold"><i class="bi bi-check-circle-fill me-1"></i> Thank you! Your inquiry was sent successfully.</span>';
  }
  event.target.reset();
}


/* ==================== CLIENT DASHBOARD & REAL-TIME SOCKET ==================== */

async function showClientDashboard() {
  const landingPage = document.getElementById('landingPage');
  if (landingPage) landingPage.style.display = 'none';

  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('clientDashboardView').style.display = 'block';
  document.getElementById('adminDashboardView').style.display = 'none';
  document.getElementById('navRoleBadge').innerText = 'Client Dashboard';
  document.getElementById('navRoleBadge').className = 'badge bg-secondary bg-opacity-25 text-info border border-info border-opacity-25 fs-8';

  const deleteBtn = document.getElementById('btnDeleteAccountTop');
  if (deleteBtn) deleteBtn.style.display = 'inline-block';

  // Initialize Real-Time Socket Connection for authenticated tenant
  initClientSocket();

  await fetchClientDashboardData();

  // Dashboard data poll: every 5s
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(fetchClientDashboardData, 5000);
}

function initClientSocket() {
  if (state.socket) state.socket.disconnect();
  if (!state.token || typeof io === 'undefined') return;

  state.socket = io({
    auth: { token: state.token }
  });

  state.socket.on('connect', () => {
    console.log('[Socket] Real-time engine connected successfully.');
  });

  state.socket.on('whatsapp_message', (msg) => {
    console.log('[Socket] Real-time message received:', msg);
    handleIncomingSocketMessage(msg);
  });

  state.socket.on('whatsapp_status', (status) => {
    console.log('[Socket] Real-time WhatsApp status change:', status);
    handleSocketStatusChange(status);
  });

  state.socket.on('whatsapp_chat_sync', (payload) => {
    console.log('[Socket] WhatsApp chat store sync signal received — refreshing chat list...');
    fetchWaWebChats();
  });

  state.socket.on('connect_error', (err) => {
    console.warn('[Socket] Connection error:', err.message);
  });
}

function handleIncomingSocketMessage(msg) {
  // Update chat list entry for the incoming message
  if (msg.chatId) {
    const existingChat = state.waChats.find(c => c.id === msg.chatId);
    if (existingChat) {
      existingChat.lastMessage = { body: msg.body, timestamp: msg.timestamp, fromMe: msg.fromMe };
      existingChat.unreadCount = msg.fromMe ? existingChat.unreadCount : (existingChat.unreadCount || 0) + 1;
      // Move to top
      state.waChats = [existingChat, ...state.waChats.filter(c => c.id !== msg.chatId)];
    } else {
      // New chat not yet in list - add it
      state.waChats.unshift({
        id: msg.chatId,
        name: msg.pushname || msg.chatId.split('@')[0],
        number: msg.chatId.split('@')[0],
        unreadCount: msg.fromMe ? 0 : 1,
        timestamp: msg.timestamp,
        isGroup: msg.chatId.endsWith('@g.us'),
        lastMessage: { body: msg.body, timestamp: msg.timestamp, fromMe: msg.fromMe }
      });
    }
    renderWaWebChats(state.waChats);
  }

  const normActive = (state.activeChatId || '').replace(/@.*$/, '');
  const normMsgChat = (msg.chatId || '').replace(/@.*$/, '');
  const normMsgSender = (msg.sender || '').replace(/@.*$/, '');

  if (state.activeChatId && (msg.chatId === state.activeChatId || msg.sender === state.activeChatId || (normActive && (normMsgChat === normActive || normMsgSender === normActive)))) {
    appendMessageBubble(msg);
    scrollMessagesToBottom();
  }
}

function setWaQrOverlayVisible(visible, qrCodeUrl = null) {
  const qrOverlay = document.getElementById('waWebQrOverlay');
  const qrImg = document.getElementById('waWebQrImg');
  const qrSpinner = document.getElementById('waWebQrSpinner');

  if (!qrOverlay) return;

  if (visible && qrCodeUrl) {
    qrOverlay.classList.remove('d-none');
    qrOverlay.classList.add('show');
    if (qrSpinner) qrSpinner.style.display = 'none';
    if (qrImg) {
      qrImg.src = qrCodeUrl;
      qrImg.style.display = 'block';
    }
  } else {
    qrOverlay.classList.remove('show');
    qrOverlay.classList.add('d-none');
  }
}

function handleSocketStatusChange(status) {
  const prevStatus = state.waStatus;
  state.waStatus = status.state || state.waStatus;

  if (status.state === 'READY') {
    setWaQrOverlayVisible(false);
    // Refresh chat list immediately when connection becomes ready
    setTimeout(() => fetchWaWebChats(), 2000);
    setTimeout(() => fetchWaWebChats(), 6000); // Retry in case store isn't fully synced
  } else if (status.qrCode) {
    setWaQrOverlayVisible(true, status.qrCode);
  } else if (status.state === 'CONNECTING' || status.state === 'LOADING' || status.state === 'AUTHENTICATING') {
    setWaQrOverlayVisible(false);
  } else if (status.state === 'DISCONNECTED') {
    if (!status.qrCode) {
      setWaQrOverlayVisible(false);
    }
  }

  fetchClientDashboardData();
}

async function fetchClientDashboardData() {
  if (!state.token || state.isAdmin) return;

  try {
    const res = await fetch(`/api/client/dashboard?_t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });

    if (res.status === 401 || res.status === 403) {
      const errData = await res.json();
      if (res.status === 403 && errData.reason && errData.reason.includes('Suspended')) {
        alert(errData.reason);
        logout();
        return;
      }
      logout();
      return;
    }

    const data = await res.json();
    if (data.status === 'success') {
      state.tenant = data.client;
      renderClientDashboard(data);
    }
  } catch (err) {
    console.error('Error fetching client dashboard:', err);
  }
}

function renderClientDashboard(data) {
  const client = data.client;
  const wa = data.whatsapp;
  const credits = data.credits;

  // Header user info
  document.getElementById('userEmailText').innerText = client.email;
  document.getElementById('userTenantIdText').innerText = client.tenant_id;
  if (client.picture) {
    document.getElementById('userAvatarImg').src = client.picture;
  }

  // 15-Day Trial & Plan Status Banner
  document.getElementById('trialExpiryDateText').innerText = client.trial_expiry_date || 'N/A';
  
  const statusBadge = document.getElementById('accountStatusBadge');
  statusBadge.innerText = (client.account_status || 'trial').toUpperCase();
  if (client.account_status === 'trial') {
    statusBadge.className = 'badge bg-info bg-opacity-20 text-info border border-info border-opacity-30 fs-8';
  } else if (client.account_status === 'active') {
    statusBadge.className = 'badge bg-success bg-opacity-20 text-success border border-success border-opacity-30 fs-8';
  } else if (client.account_status === 'expired') {
    statusBadge.className = 'badge bg-danger bg-opacity-20 text-danger border border-danger border-opacity-30 fs-8';
  } else {
    statusBadge.className = 'badge bg-warning bg-opacity-20 text-warning border border-warning border-opacity-30 fs-8';
  }

  const remainingDays = client.remaining_trial_days;
  const remainingBadge = document.getElementById('remainingDaysBadge');
  remainingBadge.innerText = `${remainingDays} Days Left`;
  if (remainingDays <= 3) {
    remainingBadge.className = 'badge bg-warning bg-opacity-20 text-warning border border-warning border-opacity-30 fs-6 px-3 py-2';
  } else if (remainingDays === 0 || client.account_status === 'expired') {
    remainingBadge.innerText = 'Trial Expired';
    remainingBadge.className = 'badge bg-danger bg-opacity-20 text-danger border border-danger border-opacity-30 fs-6 px-3 py-2';
  }

  // WhatsApp Connection Card
  const dot = document.getElementById('clientWaDot');
  const statusText = document.getElementById('clientWaStatusText');
  const numberText = document.getElementById('clientWaNumberText');

  statusText.innerText = wa.state;
  if (wa.state === 'READY') {
    dot.className = 'status-indicator ready';
    statusText.className = 'fw-bold mb-0 text-success';
    numberText.innerText = wa.number ? `Linked: +${wa.number}` : 'WhatsApp Ready';
  } else if (wa.state === 'CONNECTING' || wa.state === 'LOADING' || wa.state === 'AUTHENTICATING') {
    dot.className = 'status-indicator connecting';
    statusText.className = 'fw-bold mb-0 text-warning';
    numberText.innerText = 'Connecting to WhatsApp Web...';
  } else {
    dot.className = 'status-indicator disconnected';
    statusText.className = 'fw-bold mb-0 text-danger';
    numberText.innerText = 'Disconnected - Scan QR Code';
  }

  // QR Code Slot (Session tab & QR Overlay)
  const qrPlaceholder = document.getElementById('qrCodePlaceholder');
  const qrImg = document.getElementById('clientQrImg');
  const waNotice = document.getElementById('waConnectedNotice');

  if (wa.state === 'READY') {
    if (qrPlaceholder) qrPlaceholder.style.display = 'none';
    if (qrImg) qrImg.style.display = 'none';
    if (waNotice) waNotice.classList.remove('d-none');
    setWaQrOverlayVisible(false); // ALWAYS HIDE OVERLAY WHEN READY!
  } else if (wa.state === 'CONNECTING' || wa.state === 'LOADING' || wa.state === 'AUTHENTICATING') {
    if (qrPlaceholder) qrPlaceholder.style.display = 'block';
    if (qrImg) qrImg.style.display = 'none';
    if (waNotice) waNotice.classList.add('d-none');
    if (wa.qrCode) {
      setWaQrOverlayVisible(true, wa.qrCode);
    } else {
      setWaQrOverlayVisible(false);
    }
  } else if (wa.qrCode) {
    if (qrPlaceholder) qrPlaceholder.style.display = 'none';
    if (waNotice) waNotice.classList.add('d-none');
    if (qrImg) {
      qrImg.src = wa.qrCode;
      qrImg.style.display = 'block';
    }
    setWaQrOverlayVisible(true, wa.qrCode);
  } else {
    if (qrPlaceholder) qrPlaceholder.style.display = 'block';
    if (qrImg) qrImg.style.display = 'none';
    if (waNotice) waNotice.classList.add('d-none');
    setWaQrOverlayVisible(false);
  }

  // Metadata Table
  document.getElementById('metaWaNumber').innerText = wa.number ? `+${wa.number}` : '-';
  document.getElementById('metaWaPushname').innerText = wa.pushname || '-';
  document.getElementById('metaWaPlatform').innerText = wa.platform || '-';
  document.getElementById('metaWaVersion').innerText = wa.wwebVersion || '-';
  document.getElementById('metaTenantId').innerText = client.tenant_id;

  // Credits Cards
  document.getElementById('clientCreditsRemaining').innerText = credits.remaining;
  document.getElementById('clientCreditsUsed').innerText = credits.used;
  document.getElementById('clientCreditsAllocated').innerText = credits.allocated;

  // API Config Tab (Busy Software Credentials)
  document.getElementById('apiUsernameCode').innerText = client.api_credentials.username;
  document.getElementById('apiPasswordCode').innerText = client.api_credentials.password;
  document.getElementById('apiChannelIdCode').innerText = client.api_credentials.channel_id;

  document.getElementById('urlUser').innerText = client.api_credentials.username;
  document.getElementById('urlPass').innerText = client.api_credentials.password;
  document.getElementById('urlChan').innerText = client.api_credentials.channel_id;

  // Logs Table
  renderClientLogs(data.logs || []);
}

function renderClientLogs(logs) {
  const tbody = document.getElementById('clientLogsTableBody');
  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-secondary py-4">No transmission logs available.</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const isSuccess = log.status === 'success';
    const badgeClass = isSuccess ? 'bg-success bg-opacity-10 text-success border border-success border-opacity-20' : 'bg-danger bg-opacity-10 text-danger border border-danger border-opacity-20';

    return `
      <tr>
        <td class="text-secondary fs-8">${log.created_at}</td>
        <td class="fw-semibold text-light">+${log.mobile}</td>
        <td class="text-secondary text-truncate" style="max-width: 250px;">${escapeHtml(log.message)}</td>
        <td><span class="badge ${badgeClass} fs-8">${log.status.toUpperCase()}</span></td>
        <td class="text-danger fs-8">${log.error ? escapeHtml(log.error) : '-'}</td>
      </tr>
    `;
  }).join('');
}


/* ==================== LIVE WHATSAPP WEB CHAT ENGINE ==================== */

async function fetchWaWebChats() {
  if (!state.token || state.isAdmin) return;

  try {
    const res = await fetch(`/api/whatsapp/chats?_t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.status === 'success') {
      const newChats = data.chats || [];
      if (newChats.length > 0 || state.waChats.length === 0) {
        state.waChats = newChats;
        renderWaWebChats(state.waChats);
      }
    }
  } catch (err) {
    console.error('Error fetching live WhatsApp Web chats:', err);
  }
}

function renderWaWebChats(chats) {
  const container = document.getElementById('waChatListContainer');
  if (!container) return;

  const search = (document.getElementById('waChatSearchInput')?.value || '').toLowerCase().trim();
  const filtered = search
    ? chats.filter(c => c.name.toLowerCase().includes(search) || (c.number && c.number.includes(search)))
    : chats;

  if (!filtered || filtered.length === 0) {
    container.innerHTML = `
      <div class="text-center text-secondary py-4 px-3 fs-8">
        <i class="bi bi-chat-square-dots text-secondary opacity-50 fs-2 mb-2 d-block"></i>
        <p class="mb-2">No recent conversation chats found.</p>
        <button class="btn btn-sm btn-outline-success px-3 py-1.5 fs-8 fw-medium" onclick="openNewChatPrompt()">
          <i class="bi bi-plus-lg me-1"></i> Start New Conversation
        </button>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(chat => {
    const isActive = chat.id === state.activeChatId;
    const initial = (chat.name || 'C').charAt(0).toUpperCase();
    const timeStr = chat.timestamp ? formatTimestamp(chat.timestamp) : '';
    const lastMsgSnippet = chat.lastMessage ? chat.lastMessage.body : 'No messages yet';

    return `
      <div class="wa-chat-item ${isActive ? 'active' : ''}" data-chat-id="${escapeHtml(chat.id)}">
        <div class="wa-avatar me-3">
          ${chat.profilePic ? `<img src="${chat.profilePic}" class="rounded-circle w-100 h-100" alt="pic">` : initial}
        </div>
        <div class="flex-grow-1 min-w-0">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <h6 class="text-light fw-semibold mb-0 text-truncate fs-7" style="max-width: 140px;">${escapeHtml(chat.name)}</h6>
            <span class="text-secondary fs-8">${timeStr}</span>
          </div>
          <div class="d-flex justify-content-between align-items-center">
            <p class="text-secondary fs-8 mb-0 text-truncate" style="max-width: 150px;">${escapeHtml(lastMsgSnippet)}</p>
            ${chat.unreadCount > 0 ? `<span class="wa-unread-badge ms-1">${chat.unreadCount}</span>` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openNewChatPrompt() {
  const input = prompt('Enter receiver mobile number with country code (e.g. 919876543210):');
  if (!input) return;
  const cleanNumber = input.replace(/\D/g, '');
  if (!cleanNumber) return;
  const chatId = `${cleanNumber}@c.us`;
  
  // Add to local state if not exists
  const existing = state.waChats.find(c => c.id === chatId);
  if (!existing) {
    state.waChats.unshift({
      id: chatId,
      name: `+${cleanNumber}`,
      number: cleanNumber,
      unreadCount: 0,
      timestamp: Math.floor(Date.now() / 1000),
      lastMessage: null
    });
  }
  
  selectWaChat(chatId);
}

async function selectWaChat(chatId, name, number, avatar) {
  state.activeChatId = chatId;

  const chat = state.waChats.find(c => c.id === chatId);
  const resolvedName = name || (chat ? chat.name : chatId);
  const resolvedNumber = number || (chat ? chat.number : (chatId.includes('@') ? chatId.split('@')[0] : chatId));
  const resolvedAvatar = avatar !== undefined ? avatar : (chat ? chat.profilePic : null);

  state.activeChatName = resolvedName;

  renderWaWebChats(state.waChats);

  document.getElementById('waActiveChatHeader').style.display = 'flex';
  document.getElementById('waInputBar').style.display = 'flex';
  document.getElementById('waActiveChatName').innerText = resolvedName;
  document.getElementById('waActiveChatNumber').innerText = resolvedNumber ? `+${resolvedNumber}` : chatId;

  const avatarEl = document.getElementById('waActiveChatAvatar');
  if (resolvedAvatar) {
    avatarEl.innerHTML = `<img src="${resolvedAvatar}" class="rounded-circle w-100 h-100" alt="pic">`;
  } else {
    avatarEl.innerHTML = resolvedName.charAt(0).toUpperCase();
  }

  await fetchChatMessages(chatId);
}

async function fetchChatMessages(chatId) {
  const container = document.getElementById('waMessagesContainer');
  container.innerHTML = '<div class="text-center text-secondary py-5 fs-8"><div class="spinner-border spinner-border-sm text-success mb-2"></div><p>Loading messages...</p></div>';

  try {
    const res = await fetch(`/api/whatsapp/chats/${encodeURIComponent(chatId)}/messages?limit=50&_t=${Date.now()}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();

    if (state.activeChatId !== chatId) return; // Prevent race conditions if user switched contacts

    if (data.status === 'success') {
      renderChatMessages(data.messages || []);
    } else {
      container.innerHTML = `<div class="alert alert-danger fs-8 m-3">Failed to load chat: ${escapeHtml(data.reason)}</div>`;
    }
  } catch (err) {
    if (state.activeChatId === chatId) {
      container.innerHTML = `<div class="alert alert-danger fs-8 m-3">Network error loading messages: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderChatMessages(messages) {
  const container = document.getElementById('waMessagesContainer');
  if (!container) return;

  if (!messages || messages.length === 0) {
    container.innerHTML = `
      <div class="wa-empty-state text-center text-secondary py-5 px-3 fs-8">
        <i class="bi bi-chat-dots text-secondary opacity-50 display-4 mb-3 d-block"></i>
        <h6 class="fw-semibold text-light mb-1">No messages yet</h6>
        <p class="mb-0 text-secondary fs-8">Send a message below to start the conversation.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map(msg => {
    const isOutgoing = msg.fromMe;
    const timeStr = formatTimestamp(msg.timestamp);

    return `
      <div class="wa-msg-bubble ${isOutgoing ? 'wa-msg-outgoing' : 'wa-msg-incoming'}">
        <div>${escapeHtml(msg.body)}</div>
        <div class="wa-msg-time">
          ${timeStr}
          ${isOutgoing ? '<i class="bi bi-check2-all text-info ms-1"></i>' : ''}
        </div>
      </div>
    `;
  }).join('');

  scrollMessagesToBottom();
}

function appendMessageBubble(msg) {
  const container = document.getElementById('waMessagesContainer');
  if (!container) return;

  const emptyState = container.querySelector('.wa-empty-state');
  if (emptyState) container.innerHTML = '';

  const isOutgoing = msg.fromMe;
  const timeStr = formatTimestamp(msg.timestamp);

  const bubble = document.createElement('div');
  bubble.className = `wa-msg-bubble ${isOutgoing ? 'wa-msg-outgoing' : 'wa-msg-incoming'}`;
  bubble.innerHTML = `
    <div>${escapeHtml(msg.body)}</div>
    <div class="wa-msg-time">
      ${timeStr}
      ${isOutgoing ? '<i class="bi bi-check2-all text-info ms-1"></i>' : ''}
    </div>
  `;
  container.appendChild(bubble);
}

function scrollMessagesToBottom() {
  const container = document.getElementById('waMessagesContainer');
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}

async function sendWaWebMessage() {
  const input = document.getElementById('waMsgInputText');
  const body = (input.value || '').trim();
  if (!body || !state.activeChatId) return;

  input.value = '';

  const tempMsg = {
    chatId: state.activeChatId,
    body: body,
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000)
  };
  appendMessageBubble(tempMsg);
  scrollMessagesToBottom();

  try {
    const res = await fetch(`/api/whatsapp/chats/${encodeURIComponent(state.activeChatId)}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.token}`
      },
      body: JSON.stringify({ body })
    });
    const data = await res.json();
    if (data.status === 'success') {
      fetchClientDashboardData();
      fetchWaWebChats();
    } else {
      alert('Failed to send message: ' + (data.reason || 'Server error'));
    }
  } catch (err) {
    alert('Network error sending message: ' + err.message);
  }
}


/* ==================== MASTER ADMIN DASHBOARD LOGIC ==================== */

async function showAdminDashboard() {
  const landingPage = document.getElementById('landingPage');
  if (landingPage) landingPage.style.display = 'none';

  document.getElementById('authOverlay').style.display = 'none';
  document.getElementById('mainApp').style.display = 'block';
  document.getElementById('clientDashboardView').style.display = 'none';
  document.getElementById('adminDashboardView').style.display = 'block';
  document.getElementById('navRoleBadge').innerText = 'Master Admin Portal';
  document.getElementById('navRoleBadge').className = 'badge bg-warning bg-opacity-20 text-warning border border-warning border-opacity-30 fs-8';

  const deleteBtn = document.getElementById('btnDeleteAccountTop');
  if (deleteBtn) deleteBtn.style.display = 'none';

  document.getElementById('userEmailText').innerText = 'Master Administrator';
  document.getElementById('userTenantIdText').innerText = 'admin';

  await fetchAdminClientsData();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(fetchAdminClientsData, 5000);
}

async function fetchAdminClientsData() {
  if (!state.token || !state.isAdmin) return;

  try {
    const res = await fetch(`/api/admin/clients?_t=${Date.now()}`, {
      headers: { 
        'Authorization': `Bearer ${state.token}`,
        'Cache-Control': 'no-cache'
      }
    });

    if (res.status === 401 || res.status === 403) {
      logout();
      return;
    }

    const data = await res.json();
    if (data.status === 'success') {
      state.adminClients = data.clients || [];
      renderAdminDashboard(state.adminClients);
    }
  } catch (err) {
    console.error('Error fetching admin clients:', err);
  }
}

function renderAdminDashboard(clients) {
  const total = clients.length;
  const activeTrials = clients.filter(c => c.account_status === 'trial' && c.remaining_trial_days > 0).length;
  const expiredTrials = clients.filter(c => c.account_status === 'expired' || c.remaining_trial_days === 0).length;
  const suspended = clients.filter(c => c.account_status === 'suspended').length;
  const connectedWa = clients.filter(c => c.whatsapp_status === 'READY').length;
  const totalSent = clients.reduce((acc, c) => acc + (c.total_messages_sent || 0), 0);

  document.getElementById('adminMetricTotalClients').innerText = total;
  document.getElementById('adminMetricActiveTrials').innerText = activeTrials;
  document.getElementById('adminMetricExpiredTrials').innerText = expiredTrials;
  document.getElementById('adminMetricSuspended').innerText = suspended;
  document.getElementById('adminMetricConnectedWa').innerText = connectedWa;
  document.getElementById('adminMetricTotalSent').innerText = totalSent;

  const filterSelect = document.getElementById('adminStatusFilterSelect');
  const selectedStatus = filterSelect ? filterSelect.value : 'all';

  let statusFiltered = clients;
  if (selectedStatus === 'connected') {
    statusFiltered = clients.filter(c => c.whatsapp_status === 'READY');
  } else if (selectedStatus === 'disconnected') {
    statusFiltered = clients.filter(c => c.whatsapp_status === 'DISCONNECTED');
  } else if (selectedStatus === 'active_trial') {
    statusFiltered = clients.filter(c => c.account_status === 'active' || c.account_status === 'trial');
  } else if (selectedStatus === 'expired_suspended') {
    statusFiltered = clients.filter(c => c.account_status === 'expired' || c.account_status === 'suspended');
  }

  const search = (document.getElementById('adminSearchInput').value || '').toLowerCase().trim();
  const searchFiltered = search
    ? statusFiltered.filter(c => c.email.toLowerCase().includes(search) || c.name.toLowerCase().includes(search) || c.tenant_id.toLowerCase().includes(search))
    : statusFiltered;

  renderAdminClientsTable(searchFiltered);
}

function renderAdminClientsTable(clients) {
  const tbody = document.getElementById('adminClientsTableBody');
  if (!clients || clients.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="text-center text-secondary py-5">No client accounts found.</td></tr>';
    return;
  }

  tbody.innerHTML = clients.map(client => {
    let statusClass = 'bg-info bg-opacity-20 text-info border-info';
    if (client.account_status === 'active') statusClass = 'bg-success bg-opacity-20 text-success border-success';
    if (client.account_status === 'expired') statusClass = 'bg-danger bg-opacity-20 text-danger border-danger';
    if (client.account_status === 'suspended') statusClass = 'bg-warning bg-opacity-20 text-warning border-warning';

    const isReady = client.whatsapp_status === 'READY';
    const waClass = isReady ? 'bg-success bg-opacity-10 text-success border-success' : 'bg-danger bg-opacity-10 text-danger border-danger';

    return `
      <tr>
        <td>
          <div class="fw-bold text-light">${escapeHtml(client.name)}</div>
          <div class="text-secondary fs-8">${escapeHtml(client.email)}</div>
          <div class="text-info fs-8 font-monospace">${client.tenant_id}</div>
        </td>
        <td class="text-secondary fs-8">${client.signup_date ? client.signup_date.substring(0,10) : '-'}</td>
        <td class="text-light fs-8">${client.trial_expiry_date ? client.trial_expiry_date.substring(0,10) : '-'}</td>
        <td>
          <span class="badge ${client.remaining_trial_days <= 3 ? 'bg-warning text-dark' : 'bg-secondary'} fs-8">
            ${client.remaining_trial_days} Days
          </span>
        </td>
        <td><span class="badge ${statusClass} border border-opacity-30 fs-8">${client.account_status.toUpperCase()}</span></td>
        <td><span class="badge ${waClass} border border-opacity-30 fs-8">${client.whatsapp_status}</span></td>
        <td>
          <span class="text-success fw-bold">${client.remaining_credits}</span> / 
          <span class="text-secondary">${client.allocated_credits}</span>
        </td>
        <td class="fw-semibold text-info">${client.total_messages_sent}</td>
        <td class="text-secondary fs-8">${client.last_login_at ? client.last_login_at.substring(0,16) : 'Never'}</td>
        <td class="text-end">
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-light px-2 py-1 fs-8" type="button" data-bs-toggle="dropdown">
              Actions <i class="bi bi-chevron-down ms-1"></i>
            </button>
            <ul class="dropdown-menu dropdown-menu-dark dropdown-menu-end fs-7">
              <li><a class="dropdown-item admin-action-btn" style="cursor: pointer;" data-action="extend-trial" data-tenant-id="${client.tenant_id}" data-email="${client.email}"><i class="bi bi-calendar-plus me-2 text-info"></i>Extend Trial Expiry</a></li>
              <li><a class="dropdown-item admin-action-btn" style="cursor: pointer;" data-action="recharge" data-tenant-id="${client.tenant_id}" data-email="${client.email}"><i class="bi bi-coin me-2 text-warning"></i>Recharge Credits</a></li>
              <li><a class="dropdown-item admin-action-btn" style="cursor: pointer;" data-action="change-status" data-tenant-id="${client.tenant_id}" data-email="${client.email}" data-status="${client.account_status}"><i class="bi bi-shield-slash me-2 text-primary"></i>Change Account Status</a></li>
              <li><a class="dropdown-item admin-action-btn text-warning" style="cursor: pointer;" data-action="disconnect-wa" data-tenant-id="${client.tenant_id}" data-email="${client.email}"><i class="bi bi-power me-2"></i>Disconnect WhatsApp</a></li>
              <li><hr class="dropdown-divider"></li>
              <li><a class="dropdown-item admin-action-btn text-danger" style="cursor: pointer;" data-action="delete" data-tenant-id="${client.tenant_id}" data-email="${client.email}"><i class="bi bi-trash3 me-2"></i>Delete Client Account</a></li>
            </ul>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}


/* ==================== ADMIN ACTIONS LOGIC ==================== */

function hideAdminModal() {
  const modalEl = document.getElementById('adminActionModal');
  if (!modalEl) return;
  const modal = bootstrap.Modal.getInstance(modalEl) || bootstrap.Modal.getOrCreateInstance(modalEl);
  if (modal) modal.hide();

  setTimeout(() => {
    document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
  }, 300);
}

function openExtendTrialModal(tenantId, email) {
  const title = document.getElementById('adminActionModalTitle');
  const body = document.getElementById('adminActionModalBody');
  title.innerText = `Extend Trial: ${email}`;

  const client = state.adminClients.find(c => c.tenant_id === tenantId);
  const currentExpiry = client ? client.trial_expiry_date : null;
  const currentExpiryText = currentExpiry ? currentExpiry.substring(0, 10) : 'None';

  body.innerHTML = `
    <form id="extendTrialForm">
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary d-block mb-1">Current Trial Expiry</label>
        <div class="text-light fw-semibold fs-7">${currentExpiryText}</div>
      </div>
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary">Add Days to Trial</label>
        <input type="number" id="trialDaysInput" class="form-control bg-black bg-opacity-30 border-secondary text-light fs-7" value="15" min="1" required>
      </div>
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary d-block mb-1">Calculated New Expiry</label>
        <div id="newExpiryCalcText" class="text-info fw-bold fs-7">-</div>
      </div>
      <button type="submit" class="btn btn-info w-100 py-2 fw-semibold fs-7">Apply Trial Extension</button>
    </form>
  `;

  const daysInput = document.getElementById('trialDaysInput');
  const calcText = document.getElementById('newExpiryCalcText');

  const updateCalculation = () => {
    const daysToAdd = parseInt(daysInput.value, 10);
    if (isNaN(daysToAdd) || daysToAdd <= 0) {
      calcText.innerText = '-';
      return;
    }
    const baseDate = currentExpiry ? new Date(currentExpiry) : new Date();
    const currentDate = baseDate < new Date() ? new Date() : baseDate;
    currentDate.setDate(currentDate.getDate() + daysToAdd);
    calcText.innerText = currentDate.toISOString().substring(0, 10);
  };

  daysInput.oninput = updateCalculation;
  updateCalculation();

  const modalEl = document.getElementById('adminActionModal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();

  document.getElementById('extendTrialForm').onsubmit = async (e) => {
    e.preventDefault();
    const days = daysInput.value;

    try {
      const res = await fetch(`/api/admin/clients/${tenantId}/trial`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
        body: JSON.stringify({ days })
      });
      const data = await res.json();
      if (data.status === 'success') {
        alert(data.message);
        hideAdminModal();
        fetchAdminClientsData();
      } else {
        alert('Error: ' + data.reason);
      }
    } catch (err) {
      alert('Request failed: ' + err.message);
    }
  };
}

function openRechargeModal(tenantId, email) {
  const title = document.getElementById('adminActionModalTitle');
  const body = document.getElementById('adminActionModalBody');
  title.innerText = `Recharge Credits: ${email}`;

  body.innerHTML = `
    <form id="rechargeForm">
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary">Credits Amount to Allocate</label>
        <input type="number" id="rechargeAmountInput" class="form-control bg-black bg-opacity-30 border-secondary text-light fs-7" value="500" min="1" required>
      </div>
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary">Notes / Reference</label>
        <input type="text" id="rechargeNotesInput" class="form-control bg-black bg-opacity-30 border-secondary text-light fs-7" value="Admin Manual Recharge">
      </div>
      <button type="submit" class="btn btn-warning w-100 py-2 fw-semibold text-dark fs-7">Allocate Credits</button>
    </form>
  `;

  const modalEl = document.getElementById('adminActionModal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();

  document.getElementById('rechargeForm').onsubmit = async (e) => {
    e.preventDefault();
    const amount = document.getElementById('rechargeAmountInput').value;
    const notes = document.getElementById('rechargeNotesInput').value;

    try {
      const res = await fetch(`/api/admin/clients/${tenantId}/credits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
        body: JSON.stringify({ amount, notes })
      });
      const data = await res.json();
      if (data.status === 'success') {
        alert(data.message);
        hideAdminModal();
        fetchAdminClientsData();
      } else {
        alert('Error: ' + data.reason);
      }
    } catch (err) {
      alert('Request failed: ' + err.message);
    }
  };
}

function openChangeStatusModal(tenantId, email, currentStatus) {
  const title = document.getElementById('adminActionModalTitle');
  const body = document.getElementById('adminActionModalBody');
  title.innerText = `Update Account Status: ${email}`;

  body.innerHTML = `
    <form id="changeStatusForm">
      <div class="mb-3">
        <label class="form-label fs-7 text-secondary">Account Status</label>
        <select id="accountStatusSelect" class="form-select bg-black bg-opacity-30 border-secondary text-light fs-7">
          <option value="trial" ${currentStatus === 'trial' ? 'selected' : ''}>Trial Account</option>
          <option value="active" ${currentStatus === 'active' ? 'selected' : ''}>Active / Paid</option>
          <option value="expired" ${currentStatus === 'expired' ? 'selected' : ''}>Expired</option>
          <option value="suspended" ${currentStatus === 'suspended' ? 'selected' : ''}>Suspended</option>
        </select>
      </div>
      <button type="submit" class="btn btn-primary w-100 py-2 fw-semibold fs-7">Save Status</button>
    </form>
  `;

  const modalEl = document.getElementById('adminActionModal');
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  modal.show();

  document.getElementById('changeStatusForm').onsubmit = async (e) => {
    e.preventDefault();
    const accountStatus = document.getElementById('accountStatusSelect').value;

    try {
      const res = await fetch(`/api/admin/clients/${tenantId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
        body: JSON.stringify({ accountStatus })
      });
      const data = await res.json();
      if (data.status === 'success') {
        alert(data.message);
        hideAdminModal();
        fetchAdminClientsData();
      } else {
        alert('Error: ' + data.reason);
      }
    } catch (err) {
      alert('Request failed: ' + err.message);
    }
  };
}

async function disconnectClientWa(tenantId, email) {
  if (!confirm(`Are you sure you want to disconnect the WhatsApp Web session for ${email}?`)) return;

  try {
    const res = await fetch(`/api/admin/clients/${tenantId}/whatsapp/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message);
      fetchAdminClientsData();
    } else {
      alert('Error: ' + data.reason);
    }
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}

async function adminDeleteClientAccount(tenantId, email) {
  const confirmMsg = `PERMANENT DELETION WARNING:\n\nAre you sure you want to permanently delete the client account for "${email}"?\n\nThis will permanently wipe:\n- Saved WhatsApp session & files on disk\n- Account records & credits\n- All transaction & transmission logs\n\nThis action CANNOT be undone. Proceed?`;
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(`/api/admin/clients/${tenantId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    const data = await res.json();
    if (data.status === 'success') {
      alert(data.message || 'Client account deleted successfully.');
      fetchAdminClientsData();
    } else {
      alert('Error deleting client account: ' + (data.reason || 'Deletion failed'));
    }
  } catch (err) {
    alert('Request failed: ' + err.message);
  }
}


/* ==================== EVENT LISTENERS & UI HELPERS ==================== */

function setupEventListeners() {
  // Listen for hash change to switch login views dynamically
  window.addEventListener('hashchange', () => {
    if (!state.token) {
      showAuthOverlay();
    }
  });

  // Login Tab Switchers (Zoho SaaS Pill Tabs)
  const tabClientLoginBtn = document.getElementById('tabClientLoginBtn');
  const tabAdminLoginBtn = document.getElementById('tabAdminLoginBtn');
  const clientLoginView = document.getElementById('clientLoginView');
  const adminLoginView = document.getElementById('adminLoginView');

  if (tabClientLoginBtn && tabAdminLoginBtn) {
    tabClientLoginBtn.onclick = () => {
      clientLoginView.style.display = 'block';
      adminLoginView.style.display = 'none';

      tabClientLoginBtn.className = 'btn btn-sm btn-success w-50 py-2.5 fw-semibold d-flex align-items-center justify-content-center gap-2 rounded-2';
      tabAdminLoginBtn.className = 'btn btn-sm btn-outline-light w-50 py-2.5 fw-semibold d-flex align-items-center justify-content-center gap-2 rounded-2 border-0';
    };

    tabAdminLoginBtn.onclick = () => {
      clientLoginView.style.display = 'none';
      adminLoginView.style.display = 'block';

      tabAdminLoginBtn.className = 'btn btn-sm btn-warning w-50 py-2.5 fw-semibold text-dark d-flex align-items-center justify-content-center gap-2 rounded-2';
      tabClientLoginBtn.className = 'btn btn-sm btn-outline-light w-50 py-2.5 fw-semibold d-flex align-items-center justify-content-center gap-2 rounded-2 border-0';
    };
  }

  // Toggle Admin Password Visibility
  const toggleAdminPasswordBtn = document.getElementById('toggleAdminPasswordBtn');
  if (toggleAdminPasswordBtn) {
    toggleAdminPasswordBtn.onclick = () => {
      const input = document.getElementById('adminPasswordInput');
      const icon = document.getElementById('toggleAdminPasswordIcon');
      if (input && icon) {
        if (input.type === 'password') {
          input.type = 'text';
          icon.className = 'bi bi-eye-slash-fill';
        } else {
          input.type = 'password';
          icon.className = 'bi bi-eye-fill';
        }
      }
    };
  }

  // Forgot Password Link Trigger
  const forgotPasswordLink = document.getElementById('forgotPasswordLink');
  if (forgotPasswordLink) {
    forgotPasswordLink.onclick = (e) => {
      e.preventDefault();
      const modal = new bootstrap.Modal(document.getElementById('forgotPasswordModal'));
      modal.show();
    };
  }


  // Admin Login Form Submit
  const adminLoginForm = document.getElementById('adminLoginForm');
  if (adminLoginForm) {
    adminLoginForm.onsubmit = (e) => {
      e.preventDefault();
      const password = document.getElementById('adminPasswordInput').value;
      if (password) {
        performAdminLogin(password);
      }
    };
  }

  // Logout Buttons
  document.getElementById('btnLogoutTop').onclick = logout;

  // 1-Click Copy API Endpoint URL Button
  const btnCopyApiUrl = document.getElementById('btnCopyApiUrl');
  if (btnCopyApiUrl) {
    btnCopyApiUrl.onclick = () => {
      const user = document.getElementById('urlUser')?.innerText || 'USERNAME';
      const pass = document.getElementById('urlPass')?.innerText || 'PASSWORD';
      const chan = document.getElementById('urlChan')?.innerText || 'CHANNEL_ID';
      const origin = window.location.origin;
      const copyUrl = `${origin}/message/new?username=${user}&password=${pass}&channelId=${chan}&receiverMobileNo=<MobileNo>&message=<Message>`;
      
      navigator.clipboard.writeText(copyUrl).then(() => {
        btnCopyApiUrl.innerHTML = '<i class="bi bi-check2-circle me-1 text-success"></i> Copied to Clipboard!';
        btnCopyApiUrl.className = 'btn btn-sm btn-success w-100 py-2 fs-8 mb-3 fw-medium';
        setTimeout(() => {
          btnCopyApiUrl.innerHTML = '<i class="bi bi-clipboard me-1"></i> Copy API Endpoint URL Template';
          btnCopyApiUrl.className = 'btn btn-sm btn-outline-info w-100 py-2 fs-8 mb-3 fw-medium';
        }, 2500);
      }).catch(err => {
        console.warn('Clipboard write error:', err);
      });
    };
  }

  // Delete Account Button (Client Dashboard Navbar)
  const btnDeleteAccountTop = document.getElementById('btnDeleteAccountTop');
  if (btnDeleteAccountTop) {
    btnDeleteAccountTop.onclick = () => {
      if (!state.tenant || !state.tenant.email) return;
      document.getElementById('deleteConfirmTargetEmail').innerText = state.tenant.email;
      document.getElementById('confirmEmailInput').value = '';
      const modal = new bootstrap.Modal(document.getElementById('deleteAccountModal'));
      modal.show();
    };
  }

  // Delete Account Form Submit (Client Dashboard)
  const deleteAccountForm = document.getElementById('deleteAccountForm');
  if (deleteAccountForm) {
    deleteAccountForm.onsubmit = async (e) => {
      e.preventDefault();
      const typedEmail = document.getElementById('confirmEmailInput').value.trim().toLowerCase();
      const targetEmail = state.tenant ? state.tenant.email.trim().toLowerCase() : '';

      if (typedEmail !== targetEmail) {
        alert(`Email mismatch: Please type your exact email address (${targetEmail}) to confirm account deletion.`);
        return;
      }

      const btn = document.getElementById('btnConfirmDeleteAccount');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Deleting Account...';

      try {
        const res = await fetch('/api/client/account', {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${state.token}` }
        });
        const data = await res.json();

        if (res.ok && data.status === 'success') {
          const deleteModalEl = document.getElementById('deleteAccountModal');
          const modal = bootstrap.Modal.getInstance(deleteModalEl);
          if (modal) modal.hide();

          alert(data.message || 'Your account and all associated WhatsApp data have been permanently deleted.');
          logout();
        } else {
          alert('Account deletion failed: ' + (data.reason || 'Server error'));
        }
      } catch (err) {
        alert('Network error while deleting account: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-trash3-fill me-1"></i> Permanently Delete Account';
      }
    };
  }

  // WhatsApp Web Chat Event Handlers
  const waChatListContainer = document.getElementById('waChatListContainer');
  if (waChatListContainer) {
    waChatListContainer.onclick = (e) => {
      const item = e.target.closest('.wa-chat-item');
      if (!item) return;
      const chatId = item.dataset.chatId;
      if (chatId) {
        selectWaChat(chatId);
      }
    };
  }

  const btnRefreshWaChats = document.getElementById('btnRefreshWaChats');
  if (btnRefreshWaChats) btnRefreshWaChats.onclick = fetchWaWebChats;

  const btnSendWaWebMsg = document.getElementById('btnSendWaWebMsg');
  if (btnSendWaWebMsg) btnSendWaWebMsg.onclick = sendWaWebMessage;

  const waMsgInputText = document.getElementById('waMsgInputText');
  if (waMsgInputText) {
    waMsgInputText.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendWaWebMessage();
      }
    };
  }

  const btnMarkChatRead = document.getElementById('btnMarkChatRead');
  if (btnMarkChatRead) {
    btnMarkChatRead.onclick = async () => {
      if (!state.activeChatId) return;
      try {
        await fetch(`/api/whatsapp/chats/${encodeURIComponent(state.activeChatId)}/read`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${state.token}` }
        });
        fetchWaWebChats();
      } catch (e) {
        console.error('Error marking chat read:', e);
      }
    };
  }

  const btnWaWebScanRefresh = document.getElementById('btnWaWebScanRefresh');
  if (btnWaWebScanRefresh) btnWaWebScanRefresh.onclick = fetchClientDashboardData;

  const waChatSearchInput = document.getElementById('waChatSearchInput');
  if (waChatSearchInput) {
    waChatSearchInput.oninput = () => renderWaWebChats(state.waChats);
  }

  // Client WhatsApp Session Controls
  const btnRestartWaClient = document.getElementById('btnRestartWaClient');
  if (btnRestartWaClient) {
    btnRestartWaClient.onclick = async () => {
      try {
        await fetch('/restart', { headers: { 'Authorization': `Bearer ${state.token}` } });
        alert('WhatsApp client restart sequence initiated.');
        fetchClientDashboardData();
      } catch (e) {
        alert('Failed to restart client: ' + e.message);
      }
    };
  }

  const btnLogoutWaClient = document.getElementById('btnLogoutWaClient');
  if (btnLogoutWaClient) {
    btnLogoutWaClient.onclick = async () => {
      if (!confirm('Are you sure you want to disconnect your WhatsApp session?')) return;
      try {
        await fetch('/logout', { headers: { 'Authorization': `Bearer ${state.token}` } });
        alert('WhatsApp session disconnected.');
        fetchClientDashboardData();
      } catch (e) {
        alert('Failed to disconnect WhatsApp session: ' + e.message);
      }
    };
  }

  // Client Send Test Message Form
  const sendMessageForm = document.getElementById('sendMessageForm');
  if (sendMessageForm) {
    sendMessageForm.onsubmit = async (e) => {
      e.preventDefault();
      const mobile = document.getElementById('sendMobileInput').value;
      const message = document.getElementById('sendMessageText').value;
      const fileInput = document.getElementById('sendFileInput');

      const btn = document.getElementById('btnSubmitSendMsg');
      const resultDiv = document.getElementById('sendMessageResult');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Sending...';
      resultDiv.innerHTML = '';

      try {
        const formData = new FormData();
        formData.append('receiverMobileNo', mobile);
        formData.append('message', message);
        if (fileInput.files && fileInput.files[0]) {
          formData.append('file', fileInput.files[0]);
        }

        const res = await fetch('/message/new', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${state.token}` },
          body: formData
        });

        const data = await res.json();
        if (res.ok && data.status === 'success') {
          resultDiv.innerHTML = `<div class="alert alert-success border-success bg-success bg-opacity-10 text-success p-3 rounded-3 fs-7"><i class="bi bi-check-circle-fill me-2"></i>${data.message || 'WhatsApp message sent successfully!'}</div>`;
          document.getElementById('sendMessageText').value = '';
          fileInput.value = '';
          fetchClientDashboardData();
        } else {
          resultDiv.innerHTML = `<div class="alert alert-danger border-danger bg-danger bg-opacity-10 text-danger p-3 rounded-3 fs-7"><i class="bi bi-exclamation-triangle-fill me-2"></i>Failed: ${data.reason || 'Sending failed'}</div>`;
        }
      } catch (err) {
        resultDiv.innerHTML = `<div class="alert alert-danger border-danger bg-danger bg-opacity-10 text-danger p-3 rounded-3 fs-7">Network Error: ${err.message}</div>`;
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-send me-1"></i> Send WhatsApp Message';
      }
    };
  }

  // Refresh Client Logs Button
  const btnRefreshClientLogs = document.getElementById('btnRefreshClientLogs');
  if (btnRefreshClientLogs) {
    btnRefreshClientLogs.onclick = fetchClientDashboardData;
  }

  // Admin Search Input & Status Filter Controls
  const adminSearchInput = document.getElementById('adminSearchInput');
  if (adminSearchInput) {
    adminSearchInput.oninput = () => renderAdminDashboard(state.adminClients);
  }

  const adminStatusFilterSelect = document.getElementById('adminStatusFilterSelect');
  if (adminStatusFilterSelect) {
    adminStatusFilterSelect.onchange = () => renderAdminDashboard(state.adminClients);
  }

  // Admin Refresh Button
  const btnRefreshAdminClients = document.getElementById('btnRefreshAdminClients');
  if (btnRefreshAdminClients) {
    btnRefreshAdminClients.onclick = fetchAdminClientsData;
  }

  // Admin Table Actions Event Delegation (to comply with CSP script-src-attr 'none')
  const adminClientsTableBody = document.getElementById('adminClientsTableBody');
  if (adminClientsTableBody) {
    adminClientsTableBody.onclick = (e) => {
      const btn = e.target.closest('.admin-action-btn');
      if (!btn) return;
      e.preventDefault();

      const action = btn.getAttribute('data-action');
      const tenantId = btn.getAttribute('data-tenant-id');
      const email = btn.getAttribute('data-email');

      if (action === 'extend-trial') {
        openExtendTrialModal(tenantId, email);
      } else if (action === 'recharge') {
        openRechargeModal(tenantId, email);
      } else if (action === 'change-status') {
        const currentStatus = btn.getAttribute('data-status');
        openChangeStatusModal(tenantId, email, currentStatus);
      } else if (action === 'disconnect-wa') {
        disconnectClientWa(tenantId, email);
      } else if (action === 'delete') {
        adminDeleteClientAccount(tenantId, email);
      }
    };
  }
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const date = new Date(ts * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
