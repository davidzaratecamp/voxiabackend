const campaignModel = require('../models/campaignModel');
const contactModel = require('../models/contactModel');
const callLogModel = require('../models/callLogModel');
const promptBuilder = require('./promptBuilder');
const { getProvider } = require('./telephony/providerFactory');

/**
 * Nucleo de negocio de Voxia: no importa ningun SDK de telefonia, solo la
 * interfaz TelephonyProvider (via providerFactory). Toda la logica de
 * campanas/contactos/llamadas vive aqui, independiente de si el transporte
 * termina siendo Twilio, SIP nativo, o un proveedor futuro.
 */

async function initiateCallForContact(contact, campaign) {
  const provider = getProvider(campaign.telephony_provider);

  const callLog = await callLogModel.create({
    contactId: contact.id,
    campaignId: campaign.id,
    telephonyProvider: campaign.telephony_provider,
    status: 'queued',
  });

  const { externalCallId } = await provider.initiateOutboundCall({ contact, campaign, callLog });

  await callLogModel.setExternalCallId(callLog.id, externalCallId);
  await callLogModel.updateStatus(callLog.id, 'ringing');
  await contactModel.updateStatus(contact.id, 'calling', { incrementAttempts: true });

  return { contactId: contact.id, callLogId: callLog.id, externalCallId, status: 'ringing' };
}

async function launchCampaign(campaignId, { limit = 25 } = {}) {
  const campaign = await campaignModel.findById(campaignId);
  if (!campaign) throw new Error(`Campana ${campaignId} no encontrada.`);

  const pendingContacts = await contactModel.findPendingByCampaign(campaignId, limit);

  const results = [];
  for (const contact of pendingContacts) {
    try {
      results.push(await initiateCallForContact(contact, campaign));
    } catch (err) {
      results.push({ contactId: contact.id, status: 'error', error: err.message });
    }
  }

  if (campaign.status === 'draft') {
    await campaignModel.updateStatus(campaign.id, 'active');
  }

  return results;
}

// Llama a UN contacto puntual sin importar su call_status actual (pending,
// completed, failed...) -- pensado para volver a probar un mismo contacto
// (guion/voz nuevos) sin tener que resetear su estado a mano primero.
async function callContact(contactId) {
  const contact = await contactModel.findById(contactId);
  if (!contact) throw new Error(`Contacto ${contactId} no encontrado.`);

  const campaign = await campaignModel.findById(contact.campaign_id);
  if (!campaign) throw new Error(`El contacto ${contactId} no tiene una campana valida asociada.`);

  return initiateCallForContact(contact, campaign);
}

/**
 * Punto de entrada para el webhook de SIP nativo de OpenAI. El call center
 * ya origino la llamada por su propio trunk; aqui solo localizamos el
 * contacto por numero (dentro de la organizacion dueña del webhook que
 * llego) y devolvemos la configuracion de sesion que OpenAI debe usar para
 * el agente de voz.
 *
 * organizationId viene del query param de la URL que el cliente configuro
 * en su trunk SIP (ver webhookController.js) -- sin este filtro, dos
 * organizaciones con un contacto que comparte numero de telefono podrian
 * cruzar sus prompts/campanas.
 *
 * Simplificacion restante del MVP: dentro de una misma organizacion, se
 * asume que el numero de destino corresponde al contacto "pendiente" mas
 * reciente con ese telefono.
 */
async function handleIncomingNativeSipCall(rawBody, organizationId) {
  const provider = getProvider('openai_native_sip');
  const { toPhoneNumber, externalCallId } = provider.parseIncomingCallPayload(rawBody);

  const contact = await contactModel.findLatestByPhoneAndOrganization(toPhoneNumber, organizationId);
  if (!contact) {
    throw new Error(`No se encontro ningun contacto para el numero ${toPhoneNumber} en esta organizacion.`);
  }

  const campaign = await campaignModel.findById(contact.campaign_id);
  if (!campaign) {
    throw new Error(`El contacto ${contact.id} no tiene una campana valida asociada.`);
  }

  const callLog = await callLogModel.create({
    contactId: contact.id,
    campaignId: campaign.id,
    telephonyProvider: 'openai_native_sip',
    externalCallId,
    status: 'in_progress',
  });

  await contactModel.updateStatus(contact.id, 'calling', { incrementAttempts: true });

  const sessionConfig = promptBuilder.buildSessionConfig({ campaign, contact });

  return { sessionConfig, callLog, contact, campaign };
}

async function updateCallStatusFromProviderEvent(providerKey, rawEvent, callLogId) {
  const provider = getProvider(providerKey);
  const mapped = provider.mapStatusEvent(rawEvent);

  const callLog = await callLogModel.updateStatus(callLogId, mapped.status, {
    durationSeconds: mapped.durationSeconds,
  });

  if (['completed', 'failed', 'no_answer', 'voicemail'].includes(mapped.status)) {
    await contactModel.updateStatus(callLog.contact_id, mapped.status === 'completed' ? 'completed' : mapped.status);
  }

  return callLog;
}

async function completeCall(callLogId, { transcript, durationSeconds, outcome, estimatedTokens, estimatedCostUsd }) {
  const callLog = await callLogModel.updateStatus(callLogId, 'completed', {
    transcript,
    durationSeconds,
    outcome,
    estimatedTokens,
    estimatedCostUsd,
  });
  await contactModel.updateStatus(callLog.contact_id, 'completed');
  return callLog;
}

module.exports = {
  launchCampaign,
  callContact,
  handleIncomingNativeSipCall,
  updateCallStatusFromProviderEvent,
  completeCall,
};
