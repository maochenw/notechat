# Chat Off Record

Anonymous, self-destructing chatrooms. No accounts, no logs, no traces.

## Quick Start

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## How It Works

1. Click **Create Anonymous Room** on the landing page
2. Choose a display name
3. Share the room link with others
4. Chat — messages live only in memory
5. Room self-destructs after 30 minutes; all messages are gone forever

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** Vanilla HTML/CSS/JS (no build step)
- **Storage:** None — all data is in-memory and ephemeral

## Project Structure

```
├── server.js              # Express + Socket.IO server
├── public/
│   ├── index.html         # Landing page
│   ├── room.html          # Chat room page
│   ├── css/style.css      # Dark theme styles
│   └── js/
│       ├── landing.js     # Landing page logic
│       └── room.js        # Room/chat logic
├── package.json
└── README.md
```

## Deploy to Render

1. Push this repo to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** Node

The app reads the `PORT` environment variable automatically.

## Privacy

- No database. No logs. No message persistence.
- Messages exist only in server memory while the room is active.
- When a room's 30-minute timer expires, all data is permanently deleted.
- See `PRIVACY NOTE` comments in `server.js` for details.

## Rate Limits (MVP)

- Room creation: 5 per IP per minute
- Messages: 5 per second per connection
- Max message length: 500 characters
