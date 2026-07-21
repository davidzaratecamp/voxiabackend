const { pool } = require('../config/db');

async function create({ contactId, campaignId, telephonyProvider, externalCallId = null, status = 'queued' }) {
  const [result] = await pool.query(
    `INSERT INTO call_logs (contact_id, campaign_id, telephony_provider, external_call_id, status, started_at)
     VALUES (:contactId, :campaignId, :telephonyProvider, :externalCallId, :status, NOW())`,
    { contactId, campaignId, telephonyProvider, externalCallId, status }
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM call_logs WHERE id = :id', { id });
  return rows[0] || null;
}

async function findByExternalId(externalCallId) {
  const [rows] = await pool.query(
    'SELECT * FROM call_logs WHERE external_call_id = :externalCallId ORDER BY created_at DESC LIMIT 1',
    { externalCallId }
  );
  return rows[0] || null;
}

async function setExternalCallId(id, externalCallId) {
  await pool.query('UPDATE call_logs SET external_call_id = :externalCallId WHERE id = :id', {
    id,
    externalCallId,
  });
  return findById(id);
}

async function updateStatus(id, status, extra = {}) {
  const fields = ['status = :status'];
  const params = { id, status };

  if (extra.outcome) {
    fields.push('outcome = :outcome');
    params.outcome = extra.outcome;
  }
  if (extra.transcript !== undefined) {
    fields.push('transcript = :transcript');
    params.transcript = extra.transcript;
  }
  if (extra.durationSeconds !== undefined) {
    fields.push('duration_seconds = :durationSeconds');
    params.durationSeconds = extra.durationSeconds;
  }
  if (extra.estimatedTokens !== undefined) {
    fields.push('estimated_tokens = :estimatedTokens');
    params.estimatedTokens = extra.estimatedTokens;
  }
  if (extra.estimatedCostUsd !== undefined) {
    fields.push('estimated_cost_usd = :estimatedCostUsd');
    params.estimatedCostUsd = extra.estimatedCostUsd;
  }
  if (['completed', 'failed', 'no_answer', 'voicemail'].includes(status)) {
    fields.push('ended_at = NOW()');
  }

  await pool.query(`UPDATE call_logs SET ${fields.join(', ')} WHERE id = :id`, params);
  return findById(id);
}

async function findLive(organizationId) {
  const params = {};
  let orgFilter = '';
  if (organizationId) {
    orgFilter = 'AND camp.organization_id = :organizationId';
    params.organizationId = organizationId;
  }

  const [rows] = await pool.query(
    `SELECT cl.*, c.phone_number, c.full_name, camp.name AS campaign_name
     FROM call_logs cl
     JOIN contacts c ON c.id = cl.contact_id
     JOIN campaigns camp ON camp.id = cl.campaign_id
     WHERE cl.status IN ('queued', 'ringing', 'in_progress') ${orgFilter}
     ORDER BY cl.created_at DESC`,
    params
  );
  return rows;
}

async function findRecent(limit = 50, organizationId) {
  const params = { limit };
  let orgFilter = '';
  if (organizationId) {
    orgFilter = 'WHERE camp.organization_id = :organizationId';
    params.organizationId = organizationId;
  }

  const [rows] = await pool.query(
    `SELECT cl.*, c.phone_number, c.full_name, camp.name AS campaign_name
     FROM call_logs cl
     JOIN contacts c ON c.id = cl.contact_id
     JOIN campaigns camp ON camp.id = cl.campaign_id
     ${orgFilter}
     ORDER BY cl.created_at DESC
     LIMIT :limit`,
    params
  );
  return rows;
}

async function getDashboardMetrics(organizationId) {
  const params = {};
  let orgJoin = '';
  let orgWhere = '';
  if (organizationId) {
    orgJoin = 'JOIN campaigns camp ON camp.id = call_logs.campaign_id';
    orgWhere = 'AND camp.organization_id = :organizationId';
    params.organizationId = organizationId;
  }

  const [[activeCalls]] = await pool.query(
    `SELECT COUNT(*) AS count FROM call_logs ${orgJoin}
     WHERE call_logs.status IN ('queued', 'ringing', 'in_progress') ${orgWhere}`,
    params
  );
  const [[minutesConsumed]] = await pool.query(
    `SELECT COALESCE(SUM(call_logs.duration_seconds), 0) AS seconds FROM call_logs ${orgJoin}
     WHERE call_logs.status = 'completed' ${orgWhere}`,
    params
  );
  const [[totals]] = await pool.query(
    `SELECT
       COUNT(*) AS total_calls,
       SUM(CASE WHEN call_logs.outcome = 'promise_to_pay' OR call_logs.outcome = 'sale_confirmed' THEN 1 ELSE 0 END) AS successful_calls
     FROM call_logs ${orgJoin}
     WHERE call_logs.status = 'completed' ${orgWhere}`,
    params
  );
  const [[cost]] = await pool.query(
    `SELECT COALESCE(SUM(call_logs.estimated_cost_usd), 0) AS total_cost FROM call_logs ${orgJoin}
     WHERE 1=1 ${orgWhere}`,
    params
  );

  const totalCalls = totals.total_calls || 0;
  const successfulCalls = totals.successful_calls || 0;

  return {
    activeCalls: activeCalls.count,
    minutesConsumed: Math.round((minutesConsumed.seconds || 0) / 60),
    successRate: totalCalls > 0 ? Number(((successfulCalls / totalCalls) * 100).toFixed(1)) : 0,
    totalCalls,
    estimatedCostUsd: Number(cost.total_cost || 0),
  };
}

module.exports = {
  create,
  findById,
  findByExternalId,
  setExternalCallId,
  updateStatus,
  findLive,
  findRecent,
  getDashboardMetrics,
};
