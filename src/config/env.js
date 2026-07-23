require('dotenv').config();

function list(value, fallback = []) {
  if (!value) return fallback;
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigin: process.env.CORS_ORIGIN || '*',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'voxia',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    realtimeModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2',
    defaultVoice: process.env.OPENAI_REALTIME_VOICE_DEFAULT || 'marin',
  },

  telephony: {
    enabledProviders: list(process.env.TELEPHONY_PROVIDERS, ['twilio_realtime']),
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },

  openaiSip: {
    webhookSecret: process.env.OPENAI_SIP_WEBHOOK_SECRET || '',
  },

  // Proveedor de prueba (ver services/telephony/elevenLabsTwilioProvider.js)
  // -- necesario solo si "elevenlabs_twilio" esta en TELEPHONY_PROVIDERS.
  elevenlabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || '',
    agentId: process.env.ELEVENLABS_AGENT_ID || '',
  },

  // Proveedor de prueba (ver services/telephony/humeTwilioProvider.js) --
  // necesario solo si "hume_evi_twilio" esta en TELEPHONY_PROVIDERS.
  // secretKey no se usa en el flujo actual (autenticacion del WebSocket via
  // api_key directo, ver ws/twilioMediaStreamHandler.js) -- se guarda por
  // si mas adelante hace falta el flujo de access_token.
  hume: {
    apiKey: process.env.HUME_API_KEY || '',
    secretKey: process.env.HUME_SECRET_KEY || '',
    configId: process.env.HUME_CONFIG_ID || '',
  },

  jwt: {
    secret: process.env.JWT_SECRET || '',
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || '',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
};

// Sin fallback hardcodeado: un secreto adivinable por descuido es peor que
// fallar rapido al arrancar.
if (!env.jwt.secret) {
  throw new Error('Falta JWT_SECRET en el .env. Genera uno con: openssl rand -hex 32');
}

module.exports = env;
