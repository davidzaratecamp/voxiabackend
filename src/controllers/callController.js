const callLogModel = require('../models/callLogModel');
const { assertOrgAccess } = require('../middleware/auth');
const HttpError = require('../utils/httpError');

function resolveOrgFilter(req) {
  return req.user.role === 'admin' ? req.query.organizationId : req.user.organizationId;
}

async function live(req, res) {
  const calls = await callLogModel.findLive(resolveOrgFilter(req));
  res.json(calls);
}

async function recent(req, res) {
  const { campaignId, status, outcome, offset } = req.query;
  const limit = parseInt(req.query.limit || '25', 10);
  const result = await callLogModel.findFiltered({
    organizationId: resolveOrgFilter(req),
    campaignId,
    status,
    outcome,
    limit,
    offset: parseInt(offset || '0', 10),
  });
  res.json(result);
}

async function metrics(req, res) {
  const data = await callLogModel.getDashboardMetrics(resolveOrgFilter(req));
  res.json(data);
}

async function getById(req, res) {
  const call = await callLogModel.findByIdWithDetails(req.params.id);
  if (!call) throw new HttpError(404, 'Llamada no encontrada.');

  assertOrgAccess(req.user, call.organization_id);

  res.json(call);
}

module.exports = { live, recent, metrics, getById };
