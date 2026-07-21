const bcrypt = require('bcryptjs');
const userModel = require('../models/userModel');
const organizationModel = require('../models/organizationModel');
const { signToken } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

function serializeUser(user, organization) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    organizationId: user.organization_id,
    organizationName: organization?.name || null,
    telephonyProvider: organization?.telephony_provider || null,
  };
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    throw new HttpError(400, 'email y password son obligatorios.');
  }

  const user = await userModel.findByEmail(email);
  if (!user) {
    throw new HttpError(401, 'Credenciales invalidas.');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new HttpError(401, 'Credenciales invalidas.');
  }

  const organization = user.organization_id ? await organizationModel.findById(user.organization_id) : null;
  const token = signToken(user);

  res.json({ token, user: serializeUser(user, organization) });
}

async function me(req, res) {
  const user = await userModel.findById(req.user.id);
  if (!user) throw new HttpError(401, 'Usuario no encontrado.');

  const organization = user.organization_id ? await organizationModel.findById(user.organization_id) : null;
  res.json({ user: serializeUser(user, organization) });
}

module.exports = { login, me };
