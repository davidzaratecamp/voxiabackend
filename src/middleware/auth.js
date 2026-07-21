const jwt = require('jsonwebtoken');
const env = require('../config/env');
const HttpError = require('../utils/httpError');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, organizationId: user.organization_id, email: user.email },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new HttpError(401, 'Falta el token de autenticacion.'));
  }

  try {
    const payload = jwt.verify(token, env.jwt.secret);
    req.user = {
      id: payload.sub,
      role: payload.role,
      organizationId: payload.organizationId,
      email: payload.email,
    };
    next();
  } catch (err) {
    next(new HttpError(401, 'Token invalido o expirado.'));
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new HttpError(403, 'Esta accion requiere permisos de administrador.'));
  }
  next();
}

// Un admin (organizationId === null) tiene acceso a cualquier organizacion.
// Un client solo tiene acceso a la suya.
function assertOrgAccess(user, resourceOrganizationId) {
  if (user.role === 'admin') return;
  if (user.organizationId !== resourceOrganizationId) {
    throw new HttpError(403, 'No tienes acceso a este recurso.');
  }
}

module.exports = { signToken, authenticate, requireAdmin, assertOrgAccess };
