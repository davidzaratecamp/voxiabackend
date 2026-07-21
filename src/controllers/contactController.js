const contactModel = require('../models/contactModel');
const campaignModel = require('../models/campaignModel');
const callOrchestrator = require('../services/callOrchestrator');
const { assertOrgAccess } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

async function bulkUpload(req, res) {
  const { campaignId } = req.params;
  const { contacts } = req.body;

  const campaign = await campaignModel.findById(campaignId);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new HttpError(400, 'Se espera { contacts: [ { phone_number, full_name, balance_due } ] }');
  }

  const invalid = contacts.findIndex((c) => !c.phone_number);
  if (invalid !== -1) {
    throw new HttpError(400, `El contacto en la posicion ${invalid} no tiene phone_number.`);
  }

  const result = await contactModel.bulkInsert(campaignId, contacts);
  res.status(201).json(result);
}

async function listByCampaign(req, res) {
  const { campaignId } = req.params;
  const { status } = req.query;

  const campaign = await campaignModel.findById(campaignId);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const contacts = await contactModel.findByCampaign(campaignId, { status });
  res.json(contacts);
}

async function updateStatus(req, res) {
  const contact = await contactModel.findById(req.params.id);
  if (!contact) throw new HttpError(404, 'Contacto no encontrado.');

  const campaign = await campaignModel.findById(contact.campaign_id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const { status } = req.body;
  const valid = ['pending', 'calling', 'in_progress', 'completed', 'voicemail', 'failed', 'no_answer'];
  if (!valid.includes(status)) {
    throw new HttpError(400, `status debe ser uno de: ${valid.join(', ')}`);
  }
  const updated = await contactModel.updateStatus(req.params.id, status);
  res.json(updated);
}

async function callNow(req, res) {
  const contact = await contactModel.findById(req.params.id);
  if (!contact) throw new HttpError(404, 'Contacto no encontrado.');

  const campaign = await campaignModel.findById(contact.campaign_id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const result = await callOrchestrator.callContact(contact.id);
  res.json(result);
}

module.exports = { bulkUpload, listByCampaign, updateStatus, callNow };
