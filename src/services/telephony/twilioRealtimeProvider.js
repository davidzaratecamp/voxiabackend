const twilio = require('twilio');
const { TelephonyProvider } = require('./TelephonyProvider');
const env = require('../../config/env');
const organizationModel = require('../../models/organizationModel');
const organizationPhoneNumberModel = require('../../models/organizationPhoneNumberModel');

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
  get name() {
    return 'twilio_realtime';
  }

  // Sin cliente unico en el constructor a proposito: cada organizacion
  // puede traer su propia cuenta Twilio (ver twilio_account_sid/
  // twilio_auth_token en organizations), asi que el cliente se arma por
  // llamada con las credenciales que le correspondan a esa organizacion --
  // NULL en cualquiera de los dos campos cae a las credenciales globales
  // del .env, que es el comportamiento de siempre para organizaciones sin
  // cuenta propia.
  async initiateOutboundCall({ contact, campaign, callLog }) {
    const organization = await organizationModel.findById(campaign.organization_id);
    const accountSid = organization?.twilio_account_sid || env.twilio.accountSid;
    const authToken = organization?.twilio_auth_token || env.twilio.authToken;
    if (!accountSid) {
      throw new Error('Credenciales de Twilio no configuradas (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
    }
    const client = twilio(accountSid, authToken);

    // Pool propio de numeros (ver organization_phone_numbers): rota al que
    // lleva mas tiempo sin usarse. Si la organizacion no tiene pool propio,
    // claimNextNumber devuelve null y se usa el numero global de siempre.
    const fromNumber = (await organizationPhoneNumberModel.claimNextNumber(organization.id)) || env.twilio.fromNumber;

    const voiceWebhookUrl = new URL('/api/v1/webhooks/twilio/voice', env.publicBaseUrl);
    voiceWebhookUrl.searchParams.set('contactId', contact.id);
    voiceWebhookUrl.searchParams.set('callLogId', callLog.id);
    voiceWebhookUrl.searchParams.set('organizationId', organization.id);

    const statusCallbackUrl = new URL('/api/v1/webhooks/twilio/status', env.publicBaseUrl);
    statusCallbackUrl.searchParams.set('callLogId', callLog.id);
    statusCallbackUrl.searchParams.set('organizationId', organization.id);

    const call = await client.calls.create({
      to: contact.phone_number,
      from: fromNumber,
      url: voiceWebhookUrl.toString(),
      statusCallback: statusCallbackUrl.toString(),
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
    });

    return { externalCallId: call.sid, fromNumber };
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
