const twilio = require('twilio');
const env = require('../config/env');
const callOrchestrator = require('../services/callOrchestrator');
const organizationModel = require('../models/organizationModel');
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
//
// organizationId viene como query param en la URL del webhook (lo agrega
// twilioRealtimeProvider.js al originar la llamada) porque cada
// organizacion puede tener su propia cuenta Twilio, con su propio Auth
// Token -- validar siempre contra el token global rompería la firma para
// cualquier organizacion con cuenta propia. Sin organizationId (webhooks
// viejos o de organizaciones sin cuenta propia) cae al token global.
async function verifyTwilioSignature(req) {
  if (env.nodeEnv !== 'production') return;

  const organizationId = req.query.organizationId;
  const organization = organizationId ? await organizationModel.findById(organizationId) : null;
  const authToken = organization?.twilio_auth_token || env.twilio.authToken;

  const signature = req.headers['x-twilio-signature'];
  const url = `${env.publicBaseUrl}${req.originalUrl}`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body);
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
async function twilioVoiceWebhook(req, res) {
  await verifyTwilioSignature(req);

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
  await verifyTwilioSignature(req);

  const { callLogId } = req.query;
  await callOrchestrator.updateCallStatusFromProviderEvent('twilio_realtime', req.body, callLogId);
  res.sendStatus(204);
}

// POST /api/v1/webhooks/twilio/forward/voice?organizationId=X - webhook de
// "a call comes in" configurado directo en el numero de Twilio (no pasa por
// callOrchestrator/campaignas, es un numero del pool desviado a un celular
// personal). organizationId identifica de que cuenta Twilio es el numero
// para validar la firma con el auth_token correcto (ver verifyTwilioSignature).
async function twilioForwardVoice(req, res) {
  await verifyTwilioSignature(req);

  if (!env.forwarding.toNumber) {
    throw new HttpError(500, 'FORWARD_TO_NUMBER no esta configurado.');
  }

  const response = new twilio.twiml.VoiceResponse();
  response.dial(env.forwarding.toNumber);
  res.type('text/xml').send(response.toString());
}

// POST /api/v1/webhooks/twilio/forward/sms?organizationId=X - webhook de
// "a message comes in", mismo numero que twilioForwardVoice.
async function twilioForwardSms(req, res) {
  await verifyTwilioSignature(req);

  if (!env.forwarding.toNumber) {
    throw new HttpError(500, 'FORWARD_TO_NUMBER no esta configurado.');
  }

  const { From, Body } = req.body;
  const response = new twilio.twiml.MessagingResponse();
  response.message({ to: env.forwarding.toNumber }, `De ${From}: ${Body || ''}`);
  res.type('text/xml').send(response.toString());
}

module.exports = {
  incomingNativeSip,
  twilioVoiceWebhook,
  twilioStatusCallback,
  twilioForwardVoice,
  twilioForwardSms,
};
