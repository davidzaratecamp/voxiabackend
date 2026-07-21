const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const organizationController = require('../controllers/organizationController');

const router = express.Router();

// Montado en routes/index.js con authenticate + requireAdmin ya aplicados.
router.post('/', asyncHandler(organizationController.create));
router.get('/', asyncHandler(organizationController.list));
router.post('/:id/users', asyncHandler(organizationController.createUser));
router.get('/:id/users', asyncHandler(organizationController.listUsers));
router.post('/:id/users/:userId/reset-password', asyncHandler(organizationController.resetPassword));

module.exports = router;
