const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const contactController = require('../controllers/contactController');

const router = express.Router();

router.patch('/:id/status', asyncHandler(contactController.updateStatus));
router.post('/:id/call', asyncHandler(contactController.callNow));

module.exports = router;
