const callLogModel = require('../models/callLogModel');
const campaignModel = require('../models/campaignModel');
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
  const limit = parseInt(req.query.limit || '50', 10);
  const calls = await callLogModel.findRecent(limit, resolveOrgFilter(req));
  res.json(calls);
}

async function metrics(req, res) {
  const data = await callLogModel.getDashboardMetrics(resolveOrgFilter(req));
  res.json(data);
}

async function getById(req, res) {
  const call = await callLogModel.findById(req.params.id);
  if (!call) throw new HttpError(404, 'Llamada no encontrada.');

  const campaign = await campaignModel.findById(call.campaign_id);
  assertOrgAccess(req.user, campaign?.organization_id);

  res.json(call);
}

module.exports = { live, recent, metrics, getById };
