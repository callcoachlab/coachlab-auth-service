import { User } from '../models/User.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * GET /internal/agents?workspaceId=...&email=...&externalAgentId=...
 *
 * Lookup endpoint for M1's agent-mapping fallback (Exotel/Twilio integrations
 * may give us only an extension, email, or name — M1 calls this to resolve
 * to a real M0 user). Per the v1 bible: if no match, M1 ingests as
 * "Unassigned" and the manager maps later.
 *
 * Query params (any combination — narrowest match wins):
 *   - email: exact match (lowercased)
 *   - externalAgentId: matches User.externalAgentId or User.email
 *   - name: case-insensitive name match
 *
 * Returns:
 *   { agents: [{ id, email, name, role, teamIds, status }], matchedBy }
 *   matchedBy is one of: 'email' | 'externalAgentId' | 'name' | 'none'
 */
export const lookupAgents = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { email, externalAgentId, name } = req.query;

  if (!email && !externalAgentId && !name) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'At least one of email, externalAgentId, or name is required',
      },
    });
  }

  const baseQuery = {
    workspaceId,
    deletedAt: null,
    role: 'AGENT',
    status: { $in: ['ACTIVE', 'INVITED'] },
  };

  let agents = [];
  let matchedBy = 'none';

  if (email) {
    agents = await User.find({ ...baseQuery, email: email.toLowerCase().trim() })
      .select('_id email name role teamIds status');
    if (agents.length) matchedBy = 'email';
  }

  if (!agents.length && externalAgentId) {
    agents = await User.find({
      ...baseQuery,
      $or: [
        { externalAgentId: externalAgentId },
        { email: externalAgentId.toLowerCase() },
      ],
    }).select('_id email name role teamIds status externalAgentId');
    if (agents.length) matchedBy = 'externalAgentId';
  }

  if (!agents.length && name) {
    agents = await User.find({
      ...baseQuery,
      name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    }).select('_id email name role teamIds status');
    if (agents.length) matchedBy = 'name';
  }

  logger.info({
    action: 'INTERNAL_AGENT_LOOKUP',
    workspaceId,
    matchedBy,
    count: agents.length,
  }, 'Internal agent lookup');

  res.json({
    success: true,
    data: {
      agents: agents.map((a) => ({
        id: a._id.toString(),
        email: a.email,
        name: a.name,
        role: a.role,
        teamIds: a.teamIds,
        status: a.status,
      })),
      matchedBy,
    },
  });
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
