const twilio = require('twilio');
const { TelephonyProvider } = require('./TelephonyProvider');
const env = require('../../config/env');

const TWILIO_STATUS_MAP = {
  queued: 'queued',
  initiated: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'no_answer',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'failed',
};

/**
 * Proveedor "activo": Voxia origina la llamada saliente via API REST de
 * Twilio, y el audio se transporta con Twilio Media Streams (WebSocket)
 * hacia la API Realtime de OpenAI. Ver src/ws/twilioMediaStreamHandler.js
 * para el puente de audio.
 */
class TwilioRealtimeProvider extends TelephonyProvider {
  constructor() {
    super();
    this.client = env.twilio.accountSid ? twilio(env.twilio.accountSid, env.twilio.authToken) : null;
  }

  get name() {
    return 'twilio_realtime';
  }

  async initiateOutboundCall({ contact, campaign, callLog }) {
    if (!this.client) {
      throw new Error('Credenciales de Twilio no configuradas (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
    }

    const voiceWebhookUrl = new URL('/api/v1/webhooks/twilio/voice', env.publicBaseUrl);
    voiceWebhookUrl.searchParams.set('contactId', contact.id);
    voiceWebhookUrl.searchParams.set('callLogId', callLog.id);

    const statusCallbackUrl = new URL('/api/v1/webhooks/twilio/status', env.publicBaseUrl);
    statusCallbackUrl.searchParams.set('callLogId', callLog.id);

    const call = await this.client.calls.create({
      to: contact.phone_number,
      from: env.twilio.fromNumber,
      url: voiceWebhookUrl.toString(),
      statusCallback: statusCallbackUrl.toString(),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    return { externalCallId: call.sid };
  }

  mapStatusEvent(rawEvent) {
    const status = TWILIO_STATUS_MAP[rawEvent.CallStatus] || 'failed';
    return {
      status,
      durationSeconds: rawEvent.CallDuration ? parseInt(rawEvent.CallDuration, 10) : undefined,
    };
  }
}

module.exports = TwilioRealtimeProvider;
