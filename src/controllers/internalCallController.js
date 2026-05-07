import { Contact } from '../models/Contact.js';
import { Call } from '../models/Call.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * POST /internal/calls/upsert
 * Creates or updates a call from M1 ingestion service
 * Requires INTERNAL_SECRET Bearer token
 * Idempotent on m1_instance_id
 */
export const upsertCall = asyncHandler(async (req, res) => {
  const {
    m1_instance_id,
    m1_job_id,
    phone_normalized,
    agent_id,
    external_agent_id,
    call_datetime,
    raw_channel,
    raw_campaign,
    raw_medium,
    raw_source,
    call_type,
    audio_url,
    call_duration_seconds,
    caller_number,
    notes,
    scorecard_name,
  } = req.body;

  const workspaceId = req.workspaceId;

  // Validate required fields
  if (!m1_instance_id || !phone_normalized || !agent_id || !call_datetime) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'Missing required fields: m1_instance_id, phone_normalized, agent_id, call_datetime',
      },
    });
  }

  // Validate phone format (E.164)
  if (!/^\+\d{1,15}$/.test(phone_normalized)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PHONE',
        message: 'Phone number must be in E.164 format (e.g., +14155552671)',
      },
    });
  }

  try {
    // Check workspace isolation
    const workspace = req.workspace; // Attached by verifyInternalSecret middleware
    if (workspace._id.toString() !== workspaceId.toString()) {
      logger.warn({
        workspaceId,
        requestWorkspace: workspace._id,
        m1_instance_id,
      }, 'Workspace isolation violation detected');
      return res.status(403).json({
        success: false,
        error: {
          code: 'WORKSPACE_ISOLATION_VIOLATION',
          message: 'Request workspace does not match call workspace',
        },
      });
    }

    // Find or create Contact
    const { contact, created: contactCreated } = await Contact.findOrCreateFromCallUpsert(
      workspaceId,
      phone_normalized,
      {
        phone: phone_normalized,
        external_agent_id,
        raw_channel,
        raw_campaign,
        raw_medium,
        raw_source,
      }
    );

    if (!contact) {
      logger.error({ workspaceId, phone_normalized }, 'Failed to create/find contact');
      return res.status(500).json({
        success: false,
        error: {
          code: 'CONTACT_CREATE_FAILED',
          message: 'Failed to create or find contact',
        },
      });
    }

    // Create or update Call (idempotent on m1_instance_id)
    const { call, created: callCreated } = await Call.createOrUpdateFromM1Upsert(workspaceId, {
      m1_instance_id,
      m1_job_id,
      contactId: contact._id,
      agentId: agent_id,
      external_agent_id,
      call_datetime,
      call_type: call_type || 'inbound',
      audio_url,
      call_duration_seconds,
      caller_number,
      notes,
      scorecard_name,
      raw_channel,
      raw_campaign,
      raw_medium,
      raw_source,
    });

    if (!call) {
      logger.error({ workspaceId, m1_instance_id }, 'Failed to create/update call');
      return res.status(500).json({
        success: false,
        error: {
          code: 'CALL_UPSERT_FAILED',
          message: 'Failed to create or update call',
        },
      });
    }

    // Log M1 ingestion event for audit trail
    logger.info({
      action: 'M1_CALL_UPSERT',
      workspaceId,
      m1_instance_id,
      callId: call._id,
      contactId: contact._id,
      created: callCreated,
      contactCreated,
    }, 'M1 call upserted successfully');

    // Return response
    const statusCode = callCreated ? 201 : 200;
    res.status(statusCode).json({
      success: true,
      data: {
        callId: call._id.toString(),
        contactId: contact._id.toString(),
        m1_instance_id: call.m1_instance_id,
        created: callCreated,
        contactCreated,
      },
    });
  } catch (error) {
    logger.error({
      error: error.message,
      workspaceId,
      m1_instance_id,
      stack: error.stack,
    }, 'Error in upsertCall');

    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  }
});
