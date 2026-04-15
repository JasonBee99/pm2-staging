# PM2 Monitor

Self-hosted, multi-server process monitoring dashboard. A PM2 replacement with a central dashboard.

## Architecture

```
┌─────────────────────┐       WebSocket       ┌──────────────────────┐
│   Monitored VPS 1   │ ───────────────────→   │    Central Server     │
│   (monitor-agent)   │ ←─────────────────── │   (monitor-central)  │
├─────────────────────┤     commands/config    │                      │
│   Monitored VPS 2   │ ───────────────────→   │   ┌──────────────┐  │
│   (monitor-agent)   │                        │   │  Dashboard   │  │
└─────────────────────┘                        │   │  (React SPA) │  │
                                               │   └──────────────┘  │
                                               │   ┌──────────────┐  │
                                               │   │   MySQL 8    │  │
                                               │   └──────────────┘  │
                                               └──────────────────────┘
                                                    pm2.javawav.com
```

## Setup: Central Server (DreamHost VPS)

### 1. Install Node.js via nvm

```bash
ssh your-user@pm2.javawav.com

# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

# Install Node 20 LTS
nvm install 20
nvm alias default 20
node -v  # Should show v20.x
```

### 2. Clone and install

```bash
cd ~
git clone https://github.com/JasonBee99/pm2.javawav.git monitor-central
cd monitor-central

# Install server deps
npm install

# Install and build dashboard
cd dashboard && npm install && npm run build && cd ..
```

### 3. Configure

```bash
# Edit .env with your actual credentials
cp .env.example .env
nano .env
```

Fill in your MySQL credentials. The SESSION_SECRET should be a random string —
generate one with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 4. Run database migrations

```bash
node migrate.js
```

### 5. Create admin user

```bash
node create-admin.js
# Follow the prompts to set email + password
```

### 6. DreamHost Panel Setup

1. **Proxy**: Go to Manage Domains → set up a Proxy Server for `pm2.javawav.com` pointing to `http://localhost:3000`
2. **HTTPS**: Enable Let's Encrypt SSL for `pm2.javawav.com`

### 7. Set up persistent service

```bash
# Enable linger so services run after logout
loginctl enable-linger $USER

# Create systemd user directory
mkdir -p ~/.config/systemd/user

# Create service file
cat > ~/.config/systemd/user/monitor-central.service << 'EOF'
[Unit]
Description=PM2 Monitor Central Server
After=network.target

[Service]
WorkingDirectory=/home/YOUR_USER/monitor-central
ExecStart=/home/YOUR_USER/.nvm/versions/node/v20.18.0/bin/node src/index.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# IMPORTANT: Edit the service file to replace YOUR_USER and the correct node path
# Find your node path with: which node
nano ~/.config/systemd/user/monitor-central.service

# Enable and start
systemctl --user daemon-reload
systemctl --user enable monitor-central
systemctl --user start monitor-central

# Check status
systemctl --user status monitor-central

# View logs
journalctl --user -u monitor-central -f
```

### 8. Verify

Visit `https://pm2.javawav.com` and log in with the admin credentials you created.

---

## Setup: Agent (on each monitored VPS)

### 1. Install Node.js

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 20
nvm alias default 20
```

### 2. Install agent

```bash
cd ~
git clone https://github.com/JasonBee99/pm2.javawav.git monitor-temp
cp -r monitor-temp/monitor-agent ~/monitor-agent
rm -rf monitor-temp

cd ~/monitor-agent
npm install
```

### 3. Configure

First, add a server in the dashboard (https://pm2.javawav.com) and copy the agent token.

```bash
cat > ~/.monitorrc.json << 'EOF'
{
  "central_url": "wss://pm2.javawav.com",
  "agent_token": "PASTE_YOUR_TOKEN_HERE",
  "server_name": "my-vps-name"
}
EOF
nano ~/.monitorrc.json   # Paste your actual token
```

### 4. Set up persistent service

```bash
loginctl enable-linger $USER
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/monitor-agent.service << 'EOF'
[Unit]
Description=PM2 Monitor Agent
After=network.target

[Service]
WorkingDirectory=/home/YOUR_USER/monitor-agent
ExecStart=/home/YOUR_USER/.nvm/versions/node/v20.18.0/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

# Edit paths
nano ~/.config/systemd/user/monitor-agent.service

systemctl --user daemon-reload
systemctl --user enable monitor-agent
systemctl --user start monitor-agent
systemctl --user status monitor-agent
```

---

## Usage

### Dashboard

- **Add Server**: Click "+ Add Server", name it, copy the agent token
- **Add Process**: Navigate to a server, click "+ Add Process", enter name + command
- **Monitor**: View real-time CPU/memory charts, live logs, lifecycle events
- **Control**: Start/stop/restart processes from the dashboard
- **Alerts**: Configure webhook/discord/email notifications for crashes, high CPU/memory

### Agent Commands

On the monitored VPS:

```bash
# View agent logs
journalctl --user -u monitor-agent -f

# Restart agent
systemctl --user restart monitor-agent

# Stop agent (processes it manages will also stop)
systemctl --user stop monitor-agent
```

---

## Project Structure

```
├── monitor-central/         # Central server (runs on DreamHost)
│   ├── src/
│   │   ├── index.js         # Fastify server entry point
│   │   ├── config.js        # Environment config
│   │   ├── db.js            # MySQL pool
│   │   ├── routes/          # REST API endpoints
│   │   ├── ws/              # WebSocket handlers
│   │   ├── services/        # Business logic
│   │   └── middleware/      # Auth middleware
│   ├── dashboard/           # React SPA
│   │   └── src/
│   ├── migrations/          # SQL schema
│   ├── migrate.js           # Migration runner
│   └── create-admin.js      # Admin user CLI
│
└── monitor-agent/           # Agent (runs on monitored VPSes)
    └── src/
        ├── index.js         # Agent entry point
        ├── config.js        # Reads ~/.monitorrc.json
        ├── supervisor.js    # Process spawn/restart
        ├── metrics-collector.js  # /proc CPU/mem reading
        └── ws-client.js     # WebSocket to central
```

## Tech Stack

- **Central**: Node.js 20, Fastify, MySQL 8, React, Recharts
- **Agent**: Node.js 20, ws (WebSocket client)
- **No sudo required** — runs entirely in user space on DreamHost VPS
