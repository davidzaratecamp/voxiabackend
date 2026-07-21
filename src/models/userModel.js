const { pool } = require('../config/db');

async function create({ organizationId = null, email, passwordHash, fullName = null, role = 'client' }) {
  const [result] = await pool.query(
    `INSERT INTO users (organization_id, email, password_hash, full_name, role)
     VALUES (:organizationId, :email, :passwordHash, :fullName, :role)`,
    { organizationId, email, passwordHash, fullName, role }
  );
  return findById(result.insertId);
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = :id', { id });
  return rows[0] || null;
}

async function findByEmail(email) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = :email', { email });
  return rows[0] || null;
}

async function findByOrganization(organizationId) {
  const [rows] = await pool.query(
    'SELECT id, organization_id, email, full_name, role, created_at FROM users WHERE organization_id = :organizationId ORDER BY created_at DESC',
    { organizationId }
  );
  return rows;
}

async function updatePasswordHash(id, passwordHash) {
  await pool.query('UPDATE users SET password_hash = :passwordHash WHERE id = :id', { id, passwordHash });
  return findById(id);
}

async function countAdmins() {
  const [[row]] = await pool.query(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
  return row.count;
}

module.exports = {
  create,
  findById,
  findByEmail,
  findByOrganization,
  updatePasswordHash,
  countAdmins,
};
