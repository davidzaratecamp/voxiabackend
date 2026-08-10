const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const organizationController = require('../controllers/organizationController');

const router = express.Router();

// Montado en routes/index.js con authenticate + requireAdmin ya aplicados.
router.post('/', asyncHandler(organizationController.create));
router.get('/', asyncHandler(organizationController.list));
router.patch('/:id', asyncHandler(organizationController.update));
router.post('/:id/users', asyncHandler(organizationController.createUser));
router.get('/:id/users', asyncHandler(organizationController.listUsers));
router.post('/:id/users/:userId/reset-password', asyncHandler(organizationController.resetPassword));
router.get('/:id/phone-numbers', asyncHandler(organizationController.listPhoneNumbers));
router.post('/:id/phone-numbers', asyncHandler(organizationController.addPhoneNumbers));
router.patch('/:id/phone-numbers/:numberId', asyncHandler(organizationController.setPhoneNumberActive));
router.delete('/:id/phone-numbers/:numberId', asyncHandler(organizationController.removePhoneNumber));

module.exports = router;
