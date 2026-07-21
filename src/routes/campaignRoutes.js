const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const campaignController = require('../controllers/campaignController');
const contactController = require('../controllers/contactController');

const router = express.Router();

router.post('/', asyncHandler(campaignController.create));
router.get('/', asyncHandler(campaignController.list));
router.get('/:id', asyncHandler(campaignController.getById));
router.patch('/:id', asyncHandler(campaignController.update));
router.patch('/:id/status', asyncHandler(campaignController.updateStatus));
router.delete('/:id', asyncHandler(campaignController.remove));
router.post('/:id/launch', asyncHandler(campaignController.launch));

// Contactos anidados bajo campana
router.post('/:campaignId/contacts/bulk', asyncHandler(contactController.bulkUpload));
router.get('/:campaignId/contacts', asyncHandler(contactController.listByCampaign));

module.exports = router;
