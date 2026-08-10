const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const organizationModel = require('../models/organizationModel');
const organizationPhoneNumberModel = require('../models/organizationPhoneNumberModel');
const userModel = require('../models/userModel');
const { isProviderEnabled, listEnabledProviders } = require('../services/telephony/providerFactory');
const HttpError = require('../utils/httpError');

// E.164 basico: '+' seguido de 7 a 15 digitos, el primero distinto de 0.
const PHONE_NUMBER_REGEX = /^\+[1-9]\d{6,14}$/;

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
}

// twilio_auth_token nunca sale del backend una vez guardado -- se
// reemplaza por un booleano. El modelo si devuelve la fila completa (la
// necesita twilioRealtimeProvider.js), esta ocultacion es solo de cara al
// frontend.
function maskOrganization(organization) {
  const { twilio_auth_token, ...rest } = organization;
  return { ...rest, twilio_configured: Boolean(organization.twilio_account_sid && organization.twilio_auth_token) };
}

async function create(req, res) {
  const { name, telephonyProvider } = req.body;

  if (!name || !telephonyProvider) {
    throw new HttpError(400, 'name y telephonyProvider son obligatorios.');
  }
  if (!isProviderEnabled(telephonyProvider)) {
    throw new HttpError(400, `telephonyProvider "${telephonyProvider}" no esta habilitado.`);
  }

  const organization = await organizationModel.create({ name, telephonyProvider });
  res.status(201).json(maskOrganization(organization));
}

async function list(req, res) {
  const organizations = await organizationModel.findAll();
  res.json({ organizations: organizations.map(maskOrganization), enabledProviders: listEnabledProviders() });
}

// PATCH /organizations/:id -- por ahora solo credenciales Twilio propias.
// Los dos campos viajan juntos: o se mandan ambos (nueva credencial), o
// ambos vacios (limpiar y volver a usar la cuenta global).
async function update(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const { twilioAccountSid, twilioAuthToken } = req.body;
  const settingOne = Boolean(twilioAccountSid) || Boolean(twilioAuthToken);
  const settingBoth = Boolean(twilioAccountSid) && Boolean(twilioAuthToken);
  if (settingOne && !settingBoth) {
    throw new HttpError(400, 'twilioAccountSid y twilioAuthToken deben mandarse juntos.');
  }

  const updated = await organizationModel.update(req.params.id, { twilioAccountSid, twilioAuthToken });
  res.json(maskOrganization(updated));
}

async function listPhoneNumbers(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const numbers = await organizationPhoneNumberModel.listByOrganization(organization.id);
  res.json(numbers);
}

async function addPhoneNumbers(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const { numbers } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new HttpError(400, 'numbers debe ser un arreglo con al menos un numero.');
  }

  const cleaned = numbers.map((n) => String(n).trim()).filter(Boolean);
  const invalid = cleaned.filter((n) => !PHONE_NUMBER_REGEX.test(n));
  if (invalid.length > 0) {
    throw new HttpError(400, `Numeros invalidos (formato E.164, ej. +573001234567): ${invalid.join(', ')}`);
  }

  const updatedList = await organizationPhoneNumberModel.bulkCreate(organization.id, cleaned);
  res.status(201).json(updatedList);
}

async function setPhoneNumberActive(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const { isActive } = req.body;
  if (typeof isActive !== 'boolean') {
    throw new HttpError(400, 'isActive debe ser true o false.');
  }

  await organizationPhoneNumberModel.setActive(req.params.numberId, organization.id, isActive);
  const numbers = await organizationPhoneNumberModel.listByOrganization(organization.id);
  res.json(numbers);
}

async function removePhoneNumber(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  await organizationPhoneNumberModel.remove(req.params.numberId, organization.id);
  res.status(204).send();
}

async function createUser(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const { email, fullName } = req.body;
  if (!email) throw new HttpError(400, 'email es obligatorio.');

  const existing = await userModel.findByEmail(email);
  if (existing) throw new HttpError(409, 'Ya existe un usuario con ese email.');

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const user = await userModel.create({
    organizationId: organization.id,
    email,
    passwordHash,
    fullName,
    role: 'client',
  });

  res.status(201).json({
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    tempPassword,
  });
}

async function listUsers(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const users = await userModel.findByOrganization(organization.id);
  res.json(users);
}

async function resetPassword(req, res) {
  const organization = await organizationModel.findById(req.params.id);
  if (!organization) throw new HttpError(404, 'Organizacion no encontrada.');

  const user = await userModel.findById(req.params.userId);
  if (!user || user.organization_id !== organization.id) {
    throw new HttpError(404, 'Usuario no encontrado en esta organizacion.');
  }

  const tempPassword = generateTempPassword();
  const passwordHash = await bcrypt.hash(tempPassword, 10);
  await userModel.updatePasswordHash(user.id, passwordHash);

  res.json({ id: user.id, email: user.email, tempPassword });
}

module.exports = {
  create,
  list,
  update,
  createUser,
  listUsers,
  resetPassword,
  listPhoneNumbers,
  addPhoneNumbers,
  setPhoneNumberActive,
  removePhoneNumber,
};
