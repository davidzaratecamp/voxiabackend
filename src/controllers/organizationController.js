const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const organizationModel = require('../models/organizationModel');
const userModel = require('../models/userModel');
const { isProviderEnabled, listEnabledProviders } = require('../services/telephony/providerFactory');
const HttpError = require('../utils/httpError');

function generateTempPassword() {
  return crypto.randomBytes(9).toString('base64url');
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
  res.status(201).json(organization);
}

async function list(req, res) {
  const organizations = await organizationModel.findAll();
  res.json({ organizations, enabledProviders: listEnabledProviders() });
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

module.exports = { create, list, createUser, listUsers, resetPassword };
