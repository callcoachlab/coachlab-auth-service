import express from 'express';
import { csrfTokenEndpoint } from '../middleware/csrf.js';

const router = express.Router();

// GET /csrf — Generate CSRF token
router.get('/', csrfTokenEndpoint);

export default router;
