const campaignModel = require('../models/campaignModel');
const organizationModel = require('../models/organizationModel');
const callOrchestrator = require('../services/callOrchestrator');
const promptBuilder = require('../services/promptBuilder');
const { VALID_ACCENTS, VALID_TURN_LENGTHS } = promptBuilder;
const { assertOrgAccess } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

const DEFAULT_PREVIEW_CONTACT = {
  full_name: 'Ana Pérez',
  phone_number: '+573001234567',
  balance_due: 150000,
};

// telephonyProvider y organizationId NUNCA se toman del body del cliente:
// se derivan server-side (organizationId de la sesion o, si es admin, de un
// organizationId validado; telephonyProvider siempre copiado de
// organizations.telephony_provider). Este es el unico write-path de
// campaigns.telephony_provider -- ver comentario en schema.sql.
function validateSpeed(speed) {
  if (speed === undefined || speed === null) return;
  if (typeof speed !== 'number' || speed < 0.25 || speed > 1.5) {
    throw new HttpError(400, 'speed debe ser un numero entre 0.25 y 1.5.');
  }
}

function validateAccent(accent) {
  if (accent === undefined || accent === null) return;
  if (!VALID_ACCENTS.includes(accent)) {
    throw new HttpError(400, `accent debe ser uno de: ${VALID_ACCENTS.join(', ')}`);
  }
}

function validateTurnLength(turnLength) {
  if (turnLength === undefined || turnLength === null) return;
  if (!VALID_TURN_LENGTHS.includes(turnLength)) {
    throw new HttpError(400, `turnLength debe ser uno de: ${VALID_TURN_LENGTHS.join(', ')}`);
  }
}

function validateAllowLists(allowLists) {
  if (allowLists === undefined || allowLists === null) return;
  if (typeof allowLists !== 'boolean') {
    throw new HttpError(400, 'allowLists debe ser true o false.');
  }
}

function defaultAccentForLanguage(language) {
  return language === 'en' ? 'en_US' : 'es_CO';
}

async function create(req, res) {
  const { name, type, voice, language, accent, speed, turnLength, allowLists, systemPromptTemplate } = req.body;

  if (!name || !systemPromptTemplate) {
    throw new HttpError(400, 'name y systemPromptTemplate son obligatorios.');
  }
  if (language && !['es', 'en'].includes(language)) {
    throw new HttpError(400, 'language debe ser "es" o "en".');
  }
  validateSpeed(speed);
  validateAccent(accent);
  validateTurnLength(turnLength);
  validateAllowLists(allowLists);

  let organizationId;
  if (req.user.role === 'admin') {
    organizationId = req.body.organizationId;
    if (!organizationId) throw new HttpError(400, 'organizationId es obligatorio para un admin.');
  } else {
    organizationId = req.user.organizationId;
  }

  const organization = await organizationModel.findById(organizationId);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const campaign = await campaignModel.create({
    organizationId: organization.id,
    name,
    type: type || 'otro',
    telephonyProvider: organization.telephony_provider,
    voice: voice || 'alloy',
    language: language || 'es',
    accent: accent || defaultAccentForLanguage(language || 'es'),
    speed: speed || 1.0,
    turnLength: turnLength || 'short',
    allowLists: allowLists || false,
    systemPromptTemplate,
  });

  res.status(201).json(campaign);
}

async function list(req, res) {
  const organizationId = req.user.role === 'admin' ? req.query.organizationId : req.user.organizationId;
  const campaigns = await campaignModel.findAll(organizationId);
  res.json(campaigns);
}

async function getById(req, res) {
  const campaign = await campaignModel.findById(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);
  res.json(campaign);
}

async function updateStatus(req, res) {
  const campaign = await campaignModel.findById(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const { status } = req.body;
  const valid = ['draft', 'active', 'paused', 'completed'];
  if (!valid.includes(status)) {
    throw new HttpError(400, `status debe ser uno de: ${valid.join(', ')}`);
  }
  const updated = await campaignModel.updateStatus(req.params.id, status);
  res.json(updated);
}

async function update(req, res) {
  const campaign = await campaignModel.findById(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const { name, type, voice, language, accent, speed, turnLength, allowLists, systemPromptTemplate } = req.body;
  if (language && !['es', 'en'].includes(language)) {
    throw new HttpError(400, 'language debe ser "es" o "en".');
  }
  validateSpeed(speed);
  validateAccent(accent);
  validateTurnLength(turnLength);
  validateAllowLists(allowLists);
  const updated = await campaignModel.update(req.params.id, {
    name,
    type,
    voice,
    language,
    accent,
    speed,
    turnLength,
    allowLists,
    systemPromptTemplate,
  });
  res.json(updated);
}

async function remove(req, res) {
  const campaign = await campaignModel.findById(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  await campaignModel.remove(req.params.id);
  res.status(204).send();
}

// No toca la BD ni requiere una campana existente -- es una transformacion
// de texto pura, para que el formulario de creacion/edicion pueda mostrar
// como queda el prompt final (incluido el bloque de estilo fijo) antes de
// guardar. Ya esta protegida por el `authenticate` que envuelve /campaigns
// en routes/index.js.
function previewPrompt(req, res) {
  const { systemPromptTemplate, accent, turnLength, allowLists, sampleContact } = req.body;

  if (!systemPromptTemplate) {
    throw new HttpError(400, 'systemPromptTemplate es obligatorio.');
  }
  validateAccent(accent);
  validateTurnLength(turnLength);
  validateAllowLists(allowLists);

  const contact = { ...DEFAULT_PREVIEW_CONTACT, ...(sampleContact || {}) };
  const instructions = promptBuilder.buildInstructions(
    { systemPromptTemplate, accent, turnLength, allowLists },
    contact
  );

  res.json({ instructions });
}

async function launch(req, res) {
  const campaign = await campaignModel.findById(req.params.id);
  if (!campaign) throw new HttpError(404, 'Campana no encontrada.');
  assertOrgAccess(req.user, campaign.organization_id);

  const results = await callOrchestrator.launchCampaign(req.params.id, { limit: req.body?.limit });
  res.json({ campaignId: req.params.id, results });
}

module.exports = { create, list, getById, updateStatus, update, remove, launch, previewPrompt };
