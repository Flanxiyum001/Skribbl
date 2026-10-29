# 🎨 DoodleDash — multiplayer drawing & guessing

An original Skribbl-style browser party game with private rooms. Runs as one **Node.js HTTP + WebSocket service** on Render. No Cloudflare dependency.

## Features

- Shareable 6-character rooms for up to 12 players
- Real-time canvas, colors, eraser and brush sizes
- Secret words, drawing turns, hints, scoring, leaderboard and chat
- Host controls, automatic turn timers, reconnect and mobile layout

## Local development

Node.js 22 or newer:

```bash
npm install
npm run check
npm start
```

Visit http://localhost:8787. Use two tabs to test a game.

## Deploy to Render

1. Connect your GitHub repository at https://dashboard.render.com/.
2. [Deploy this branch to Render](https://render.com/deploy?repo=https://github.com/Flanxiyum001/Skribbl/tree/feat/doodledash-multiplayer) (uses `render.yaml`).
3. Review the **Free** Node Web Service. Approve deployment.
4. Once the service reports **Live**, open its `https://<name>.onrender.com` link and share room invites.

Manual setup: New → Web Service → repo `Flanxiyum001/Skribbl`, branch `feat/doodledash-multiplayer`, build `npm install --no-audit --no-fund`, start `npm start`, health check `/api/health`.

### Limitations

- Free Render web services spin down after about **15 minutes without inbound traffic**. A sleeping service can take time to wake up.
- Rooms and scores are stored **in memory only**. Server restarts, spin-down, or redeployment reset them.
- This is a hobby multiplayer server, not a permanent database or a moderation-equipped public service.
- A public HTTPS domain does **not** guarantee access through an employer firewall; follow your office's acceptable-use policy.

## Tests

`npm run check` validates code and game logic. `npm run smoke` exercises real WebSocket multiplayer against a running local Node server. GitHub Actions runs both.
