import { AuditLog } from '../models/AuditLog.js';

export async function logAuditEvent({
  workspaceId,
  actorUserId,
  actionType,
  entityType,
  entityId,
  metadata = {},
}) {
  try {
    await AuditLog.create({
      workspaceId,
      actorUserId,
      actionType,
      entityType,
      entityId,
      metadata,
    });
  } catch (error) {
    console.error('Failed to log audit event:', error);
    // Don't throw, just log the error
  }
}
