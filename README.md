# WhatsApp REST API Gateway for Busy Accounting Software

A production-ready Node.js REST API Server built using Express.js and `whatsapp-web.js` that behaves exactly like the legacy HTTP SMS/WhatsApp Gateway used by **Busy Accounting Software**. It allows you to dispatch automated invoices, ledgers, and voucher receipts directly to your customers' WhatsApp numbers.

---

## Features

- **Busy Compatibility**: Exposes `GET /message/new` and `POST /message/new` behaving exactly like standard legacy SMS gateways.
- **Robust Session Retention**: Leverages Puppeteer headless browser cache and `LocalAuth` to maintain your WhatsApp session across restarts.
- **Admin Configuration UI**: Features a beautiful glassmorphism Dashboard built with Bootstrap 5 to monitor message delivery status, view connection state, scan QR codes, read the last 100 transaction logs, restart the client, and update gateway credentials on-the-fly.
- **Winston & SQLite Logger**: Dual logging layer that stores transactions in a SQLite database (`logs/database.db`) with dynamic fallback to JSON text files if SQLite is unavailable.
- **High Security**: Armed with Helmet security headers, CORS protection, and Express Rate Limit settings.
- **Auto-Reconnect & Recovery**: Monitors disconnects and attempts soft browser restarts automatically.

---

## Directory Structure

```
whatsapp-busy-gateway/
│
├── app.js                 # Express server & core lifecycle initializations
├── config/
│   ├── config.js          # Unified config loader (dotenv + JSON overrides)
│   └── config.json        # Dynamic runtime settings written from Dashboard UI
│
├── controllers/
│   ├── messageController.js # Handles validation, number cleaning, and sending
│   └── systemController.js  # Handles status queries, QR downloads, logs, restarts
│
├── middleware/
│   ├── auth.js            # Unified credential validation (Query, Body, and Headers)
│   └── security.js        # Configures rate limiting, Helmet, and CORS policies
│
├── services/
│   ├── db.js              # SQLite log interface (and dynamic compilation fallback)
│   ├── logService.js      # Unified message tracking and log parsing
│   ├── logger.js          # Core Winston rolling log system
│   ├── numberHelper.js    # Sanitizes, validates, and appends @c.us to numbers
│   └── whatsapp.js        # Core whatsapp-web.js / Puppeteer lifecycle manager
│
├── routes/
│   ├── messageRoutes.js   # Message sending endpoints (/message/new)
│   └── systemRoutes.js    # Administrative and settings API endpoints
│
├── public/                # Dashboard assets served on root "/"
│   ├── index.html         # Bootstrap 5 Dashboard UI
│   ├── styles.css         # Glassmorphism dashboard stylesheets
│   └── dashboard.js       # Client side API polling and action execution script
│
├── logs/                  # Winston rotating logs, messages.jsonl, SQLite database
├── session/               # Persistent WhatsApp Web LocalAuth session files
├── views/                 # Placeholder views folder
├── .env                   # Initial static configuration variables
├── .env.example           # Reference documentation for environment variables
└── package.json           # Project manifest
```

---

## 1. Quick Start Installation

### Prerequisites
- Node.js (Latest LTS version 18 or 20+ recommended)
- A mobile device with active WhatsApp to scan the QR code.

### Step 1: Install Dependencies
Open terminal/cmd in the project directory and run:
```bash
npm install
```

### Step 2: Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Inside `.env`, configure your default credentials. These are the values that Busy Accounting will send to authorize requests:
```ini
API_USERNAME=14125037
API_PASSWORD=123456
API_CHANNEL_ID=29979
PORT=3005
```

### Step 3: Run the Server
For development (with auto-reload using nodemon):
```bash
npm run dev
```
For production:
```bash
npm start
```
Once launched, open **`http://localhost:3005`** in a browser. Enter the credentials you set in your `.env` (Username: `14125037`, Password: `123456`, Channel ID: `29979`) to log into the administrative dashboard. Scan the displayed QR code with your mobile device.

---

## 2. Busy Accounting Software Integration Setup

Configure Busy Accounting to route invoices via your new local server:

1. Open **Busy Accounting Software**.
2. Navigate to **Administration** -> **Configuration** -> **SMS Configuration**.
3. Under **Add New Gateway**, input a gateway name (e.g. `WhatsApp_Local`).
4. Set the **API URL** to:
   `http://localhost:3005/message/new`
5. Map the query parameters to Busy's variables exactly as follows:
   - **Parameter 1**: `username` = `14125037`
   - **Parameter 2**: `password` = `123456`
   - **Parameter 3**: `channelid` = `29979`
   - **Parameter 4**: `receiverMobileNo` = `91<MOBILE_NO>` (or `<MOBILE_NO>`, the API automatically handles both)
   - **Parameter 5**: `message` = `<MSG>`
6. Save the Configuration.

### Dynamic Integration URL Example
Busy Software sends the message via an HTTP GET request formatting the URL like:
```
http://localhost:3005/message/new?username=14125037&password=123456&channelid=29979&receiverMobileNo=919876543210&message=Dear%20Customer%2C%20your%20invoice%20INV-2026-004%20for%20Rs.5400%20is%20ready.
```

---

## 3. Production Deployment Guides

### A. Windows Service (Recommended for Windows Environments)
To run this application in the background and ensure it launches automatically when the Windows Server boots (without keeping a CMD window open):

#### Method 1: Using PM2 (Easiest)
1. Install PM2 globally:
   ```bash
   npm install pm2 -g
   ```
2. Install the Windows Startup Service utility for PM2:
   ```bash
   npm install pm2-windows-startup -g
   pm2-startup install
   ```
3. Start the application inside the project folder:
   ```bash
   pm2 start app.js --name "whatsapp-busy-gateway"
   ```
4. Save the PM2 list so it restarts on system reboot:
   ```bash
   pm2 save
   ```

#### Method 2: Using Node-Windows (Native Service wrapper)
If you prefer a native Windows Service listed under `services.msc`:
1. Install `node-windows` in the project:
   ```bash
   npm install node-windows --save-dev
   ```
2. Create an installation script `scripts/install-service.js`:
   ```javascript
   const Service = require('node-windows').Service;
   const svc = new Service({
     name: 'WhatsApp Busy Gateway',
     description: 'WhatsApp REST Gateway Service for Busy Accounting Software Integration',
     script: require('path').join(__dirname, '../app.js')
   });
   svc.on('install', () => svc.start());
   svc.install();
   ```
3. Run the script once as **Administrator**:
   ```bash
   node scripts/install-service.js
   ```

---

### B. IIS Reverse Proxy Configuration
If you want to host the server behind IIS (Port 80/443) and map it to a domain (e.g. `whatsapp.local`):

1. Install **IIS (Internet Information Services)** on your Windows Server.
2. Install **Application Request Routing (ARR)** and **URL Rewrite** extensions in IIS.
3. Open IIS Manager, click on the Server Node, open **Application Request Routing Cache**, click **Server Settings**, and ensure **Enable Proxy** is checked.
4. Create a new Website or map an existing one, and place this `web.config` file in its root directory:
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <configuration>
     <system.webServer>
       <rewrite>
         <rules>
           <rule name="ReverseProxyToNode" stopProcessing="true">
             <match url="(.*)" />
             <action type="Rewrite" url="http://localhost:3005/{R:1}" />
           </rule>
         </rules>
       </rewrite>
     </system.webServer>
   </configuration>
   ```

---

### C. Linux (Ubuntu Server) Deployment
When deploying on headless Ubuntu Server, you must install additional system packages so Chromium/Puppeteer runs correctly without a graphical user interface (GUI).

#### Step 1: Install Chromium Dependencies
```bash
sudo apt update
sudo apt install -y gconf-service libgbm-dev libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation libappindicator1 libnss3 lsb-release xdg-utils wget
```

#### Step 2: Configure Systemd Daemon Service
Create a service configuration file:
```bash
sudo nano /etc/systemd/system/whatsapp-gateway.service
```
Paste the following configurations (adjust user, group, and path directories):
```ini
[Unit]
Description=WhatsApp REST API Gateway Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/var/www/whatsapp-busy-gateway
ExecStart=/usr/bin/node app.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=whatsapp-gateway
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```
Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable whatsapp-gateway.service
sudo systemctl start whatsapp-gateway.service
```

#### Step 3: Configure Nginx Reverse Proxy
Add a reverse proxy block inside `/etc/nginx/sites-available/default`:
```nginx
server {
    listen 80;
    server_name whatsapp.yourcompany.com;

    location / {
        proxy_pass http://localhost:3005;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```
Reload Nginx:
```bash
sudo systemctl reload nginx
```

---

## 4. API Reference Documentation

### A. Send Text Message
- **Endpoint**: `GET` / `POST` `/message/new`
- **Authentication**: Requires username, password, channelid parameters in Query, JSON body, or Headers.
- **Parameters**:
  - `receiverMobileNo`: Cleans punctuation/brackets automatically. Indian numbers are standardized by prefixing `91` and suffixing `@c.us`.
  - `message`: URL-encoded string containing text (GET) or JSON string (POST).

**POST Request Example**:
```bash
curl -X POST http://localhost:3005/message/new \
  -H "Content-Type: application/json" \
  -d '{
    "username": "14125037",
    "password": "123456",
    "channelid": "29979",
    "receiverMobileNo": "9876543210",
    "message": "Dear Valued Customer, Invoice has been generated."
  }'
```

**Response (Success)**:
```json
{
  "status": "success",
  "message": "WhatsApp Sent Successfully",
  "mobile": "919876543210",
  "time": "2026-07-18 12:35:00"
}
```

**Response (Failure)**:
```json
{
  "status": "failed",
  "reason": "Invalid Number"
}
```

---

### B. Session and QR Admin Endpoints
*(All routes require Headers: `X-API-Username`, `X-API-Password`, `X-API-ChannelID`)*

- **GET `/status`**: Returns operational state, uptime in seconds, statistics counters, and connected platform details.
- **GET `/qr`**: Fetches active QR data URL. Call with header `Accept: image/png` or query `?raw=true` to get raw binary PNG stream.
- **GET `/restart`**: Soft reboots the Chromium instance.
- **GET `/logout`**: Wipes session directories on the disk to trigger fresh scanning.

---

## 5. Architectural Guide: Extending APIs for Future Features

The architecture is highly modular to support quick extensions. Here are references on how to add media, locations, or template broad-casts in the future.

### A. Future Feature: Sending PDFs / Invoices
To support sending a PDF document URL (useful for sending actual Busy invoice attachments):

1. **Add Route** inside `routes/messageRoutes.js`:
   ```javascript
   router.post('/pdf', authMiddleware, messageController.sendPDFMessage);
   ```

2. **Expose Media helper** inside `services/whatsapp.js`:
   ```javascript
   const { MessageMedia } = require('whatsapp-web.js');

   async function sendPDF(to, pdfUrl, fileName, caption) {
     const media = await MessageMedia.fromUrl(pdfUrl);
     return await client.sendMessage(to, media, {
       caption: caption,
       filename: fileName
     });
   }
   ```

3. **Add Controller Logic** inside `controllers/messageController.js`:
   ```javascript
   exports.sendPDFMessage = async (req, res) => {
     const { receiverMobileNo, pdfUrl, fileName, caption } = req.body;
     const JID = sanitizeAndFormatNumber(receiverMobileNo);
     
     try {
       await whatsappService.sendPDF(JID, pdfUrl, fileName, caption);
       return res.status(200).json({ status: 'success', message: 'PDF Sent Successfully' });
     } catch (err) {
       return res.status(500).json({ status: 'failed', reason: err.message });
     }
   };
   ```

### B. Future Feature: Broadcast / Bulk Dispatching
To send a message to a list of contacts with a small safety delay to prevent WhatsApp spam bans:

1. **Add loop service** in `services/whatsapp.js`:
   ```javascript
   const delay = ms => new Promise(res => setTimeout(res, ms));

   async function sendBulkMessage(numbersArray, text) {
     for (const rawNum of numbersArray) {
       const JID = sanitizeAndFormatNumber(rawNum);
       if (JID) {
         await client.sendMessage(JID, text);
         // Add 3-5 seconds dynamic delay between sends to avoid spam flags
         await delay(3000 + Math.random() * 2000);
       }
     }
   }
   ```
