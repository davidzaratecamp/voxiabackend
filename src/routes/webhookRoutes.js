const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

// Publico: lo invocan Twilio/OpenAI, no un usuario logueado. Autenticado
// por secreto compartido (SIP nativo) o firma (Twilio, solo en produccion) --
// ver webhookController.js.
router.post('/openai/incoming', asyncHandler(webhookController.incomingNativeSip));
router.post('/twilio/voice', asyncHandler(webhookController.twilioVoiceWebhook));
router.post('/twilio/status', asyncHandler(webhookController.twilioStatusCallback));

module.exports = router;
