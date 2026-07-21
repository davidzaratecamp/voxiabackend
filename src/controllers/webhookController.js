const twilio = require('twilio');
const env = require('../config/env');
const callOrchestrator = require('../services/callOrchestrator');
const HttpError = require('../utils/httpError');

function toWebSocketUrl(httpUrl) {
  return httpUrl.replace(/^http/, 'ws');
}

function verifySipWebhookSecret(req) {
  const provided = req.headers['x-voxia-sip-secret'];
  if (!provided || provided !== env.openaiSip.webhookSecret) {
    throw new HttpError(401, 'Firma de webhook invalida.');
  }
}

// Solo en produccion: en local no hay forma de generar una firma real de
// Twilio para probar con curl, y bloquearla ahi rompe el flujo de pruebas
// que ya usamos en este proyecto.
function verifyTwilioSignature(req) {
  if (env.nodeEnv !== 'production') return;

  const signature = req.headers['x-twilio-signature'];
  const url = `${env.publicBaseUrl}${req.originalUrl}`;
  const valid = twilio.validateRequest(env.twilio.authToken, signature, url, req.body);
  if (!valid) {
    throw new HttpError(401, 'Firma de Twilio invalida.');
  }
}

// POST /api/v1/webhooks/openai/incoming?organizationId=X - webhook invocado
// por OpenAI (SIP nativo). organizationId identifica de que cliente es la
// llamada -- sin esto, dos organizaciones con un contacto que comparte
// numero de telefono podrian cruzarse (ver contactModel.findLatestByPhoneAndOrganization).
async function incomingNativeSip(req, res) {
  verifySipWebhookSecret(req);

  const organizationId = req.query.organizationId;
  if (!organizationId) {
    throw new HttpError(400, 'Falta organizationId en la URL del webhook.');
  }

  const { sessionConfig } = await callOrchestrator.handleIncomingNativeSipCall(req.body, organizationId);
  res.json(sessionConfig);
}

// POST /api/v1/webhooks/twilio/voice - TwiML webhook, Twilio lo pide al contestar
function twilioVoiceWebhook(req, res) {
  verifyTwilioSignature(req);

  const { contactId, callLogId } = req.query;
  const streamUrl = `${toWebSocketUrl(env.publicBaseUrl)}/api/v1/webhooks/twilio/stream`;

  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect();
  const stream = connect.stream({ url: streamUrl });
  stream.parameter({ name: 'contactId', value: String(contactId) });
  stream.parameter({ name: 'callLogId', value: String(callLogId) });

  res.type('text/xml').send(response.toString());
}

// POST /api/v1/webhooks/twilio/status - status callback de Twilio
async function twilioStatusCallback(req, res) {
  verifyTwilioSignature(req);

  const { callLogId } = req.query;
  await callOrchestrator.updateCallStatusFromProviderEvent('twilio_realtime', req.body, callLogId);
  res.sendStatus(204);
}

module.exports = { incomingNativeSip, twilioVoiceWebhook, twilioStatusCallback };
