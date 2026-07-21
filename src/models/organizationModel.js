const { pool } = require('../config/db');

async function create({ name, telephonyProvider }) {
  const [result] = await pool.query(
    'INSERT INTO organizations (name, telephony_provider) VALUES (:name, :telephonyProvider)',
    { name, telephonyProvider }
  );
  return findById(result.insertId);
}

async function findAll() {
  const [rows] = await pool.query(
    `SELECT o.*, COUNT(DISTINCT c.id) AS total_campaigns
     FROM organizations o
     LEFT JOIN campaigns c ON c.organization_id = o.id
     GROUP BY o.id
     ORDER BY o.created_at DESC`
  );
  return rows;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM organizations WHERE id = :id', { id });
  return rows[0] || null;
}

module.exports = { create, findAll, findById };
