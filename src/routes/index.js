const express = require('express');
const authRoutes = require('./authRoutes');
const organizationRoutes = require('./organizationRoutes');
const campaignRoutes = require('./campaignRoutes');
const contactRoutes = require('./contactRoutes');
const callRoutes = require('./callRoutes');
const webhookRoutes = require('./webhookRoutes');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { listEnabledProviders } = require('../services/telephony/providerFactory');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok', enabledProviders: listEnabledProviders() });
});

// Publicas (sin JWT): login y los webhooks que invocan Twilio/OpenAI.
router.use('/auth', authRoutes);
router.use('/webhooks', webhookRoutes);

// Protegidas (JWT requerido; scoping por organizacion dentro de cada controller).
router.use('/organizations', authenticate, requireAdmin, organizationRoutes);
router.use('/campaigns', authenticate, campaignRoutes);
router.use('/contacts', authenticate, contactRoutes);
router.use('/calls', authenticate, callRoutes);

module.exports = router;
