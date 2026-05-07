import { AuditLog } from '../models/AuditLog.js';
import { ErrorCodes } from '../utils/errors.js';
import { paginatedResponse } from '../utils/response.js';

export async function getAuditLogs(req, res, next) {
  try {
    const { actionType, page, limit } = req.validatedQuery;

    const query = { workspaceId: req.workspaceId };
    if (actionType) query.actionType = actionType;

    const total = await AuditLog.countDocuments(query);
    const logs = await AuditLog.find(query)
      .populate('actorUserId', 'email name')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const data = logs.map(log => ({
      id: log._id,
      actionType: log.actionType,
      entityType: log.entityType,
      entityId: log.entityId,
      actorUser: log.actorUserId
        ? {
            id: log.actorUserId._id,
            email: log.actorUserId.email,
            name: log.actorUserId.name,
          }
        : null,
      metadata: log.metadata,
      createdAt: log.createdAt,
    }));

    res.json(paginatedResponse(data, page, limit, total));
  } catch (error) {
    next(error);
  }
}
