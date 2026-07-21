const http = require('http');
const { WebSocketServer } = require('ws');
const app = require('./app');
const env = require('./config/env');
const { initDatabase } = require('./db/init');
const { registerTwilioMediaStreamHandler } = require('./ws/twilioMediaStreamHandler');

async function start() {
  await initDatabase();

  const server = http.createServer(app);

  // WebSocket dedicado al Media Stream de Twilio, montado sobre el mismo
  // puerto HTTP en /api/v1/webhooks/twilio/stream.
  const wss = new WebSocketServer({ noServer: true });
  registerTwilioMediaStreamHandler(wss);

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url, env.publicBaseUrl);
    if (pathname === '/api/v1/webhooks/twilio/stream') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(env.port, () => {
    console.log(`[voxia-backend] Escuchando en http://localhost:${env.port}`);
  });
}

start().catch((err) => {
  console.error('[voxia-backend] Error al iniciar el servidor:', err);
  process.exit(1);
});
