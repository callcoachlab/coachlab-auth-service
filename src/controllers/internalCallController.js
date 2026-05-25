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
    // call_duration_seconds intentionally not destructured — M1 doesn't send
    // it. AI/transcription service writes duration via /internal/calls/:id/result.
    caller_number,
    notes,
    scorecard_name,
    // New fields M1 may send (optional — kept on Call.metadata for audit)
    external_call_id,
    display_name,
    channel,
    campaign,
    language,
    audio_s3_key,
    audio_sha256,
    audio_size_bytes,
    // Real MIME + extension detected from bytes at /finalize.
    // (Replaces the old client-trusted audio_content_type + file_name.)
    audio_detected_mime,
    audio_detected_extension,
    recording_source,
    consent_recorded,
    scorecard_id,
    call_upload_id,
    import_batch_id,
    is_duplicate,
    duplicate_of_call_upload_id,
  } = req.body;

  const workspaceId = req.workspaceId;

  // Required fields per the v1 bible:
  //   - m1_instance_id: idempotency key
  //   - call_datetime:  required for time-ordering
  //   - one of: phone_normalized OR caller_number (so we can normalize)
  //
  // Optional:
  //   - agent_id is optional. The bible explicitly supports "Unassigned"
  //     calls (admin/manager uploads where the agent is not yet known —
  //     manager maps later in QA Queue).
  if (!m1_instance_id || !call_datetime) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'Missing required fields: m1_instance_id, call_datetime',
      },
    });
  }

  // Accept caller_number as the source if phone_normalized isn't sent.
  // M1's CallUpload uses customerPhone (E.164) which gets sent as caller_number.
  const phoneE164 = phone_normalized || caller_number || null;

  // If a phone is provided at all, it MUST be E.164. Null is allowed
  // (some manual uploads have no customer phone — internal training calls).
  if (phoneE164 && !/^\+\d{1,15}$/.test(phoneE164)) {
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

    // Find or create Contact — only when we have a phone number to key on.
    // Calls without a phone (manual training uploads, etc.) get a null contactId.
    let contact = null;
    let contactCreated = false;
    if (phoneE164) {
      const result = await Contact.findOrCreateFromCallUpsert(
        workspaceId,
        phoneE164,
        {
          phone: phoneE164,
          external_agent_id,
          raw_channel: raw_channel || channel,
          raw_campaign: raw_campaign || campaign,
          raw_medium,
          raw_source,
        }
      );
      contact = result.contact;
      contactCreated = result.created;

      if (!contact) {
        logger.error({ workspaceId, phoneE164 }, 'Failed to create/find contact');
        return res.status(500).json({
          success: false,
          error: {
            code: 'CONTACT_CREATE_FAILED',
            message: 'Failed to create or find contact',
          },
        });
      }
    }

    // Create or update Call (idempotent on m1_instance_id).
    // Note: call_duration_seconds is NOT passed — duration is owned by the
    // AI service and arrives later via /internal/calls/:callId/result.
    const { call, created: callCreated } = await Call.createOrUpdateFromM1Upsert(workspaceId, {
      m1_instance_id,
      m1_job_id,
      contactId: contact?._id || null,
      agentId: agent_id || null,
      external_agent_id,
      call_datetime,
      call_type: call_type || 'inbound',
      audio_url,
      caller_number: phoneE164,
      notes,
      scorecard_name,
      scorecard_id,
      call_upload_id,
      raw_channel: raw_channel || channel,
      raw_campaign: raw_campaign || campaign,
      raw_medium,
      raw_source,
      // M1-side audit metadata stored on Call.metadata
      external_call_id,
      display_name,
      language,
      audio_s3_key,
      audio_sha256,
      audio_size_bytes,
      audio_detected_mime,
      audio_detected_extension,
      recording_source,
      consent_recorded,
      import_batch_id,
      is_duplicate,
      duplicate_of_call_upload_id,
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
      contactId: contact?._id || null,
      created: callCreated,
      contactCreated,
    }, 'M1 call upserted successfully');

    // Return response
    const statusCode = callCreated ? 201 : 200;
    res.status(statusCode).json({
      success: true,
      data: {
        callId: call._id.toString(),
        contactId: contact?._id?.toString() || null,
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

    // Internal endpoint — the only caller is M1 (service-to-service over the
    // private network). Surfacing the real error makes diagnosis 10x faster
    // without leaking it to end users (frontend never hits /internal/*).
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: error.message || 'An unexpected error occurred',
        ...(process.env.NODE_ENV !== 'production' && { stack: error.stack }),
      },
    });
  }
});
