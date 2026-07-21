const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const callController = require('../controllers/callController');

const router = express.Router();

// Montado en routes/index.js con authenticate ya aplicado.
router.get('/live', asyncHandler(callController.live));
router.get('/metrics', asyncHandler(callController.metrics));
router.get('/:id', asyncHandler(callController.getById));
router.get('/', asyncHandler(callController.recent));

module.exports = router;
