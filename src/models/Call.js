import mongoose from 'mongoose';

const callSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
    },
    contactId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Contact',
      default: null,
    },
    direction: {
      type: String,
      enum: ['INBOUND', 'OUTBOUND'],
    },
    duration: {
      type: Number, // in seconds
    },
    timestamp: {
      type: Date,
    },
    source: {
      type: String, // e.g., "EXOTEL", "TWILIO", "BULK_UPLOAD"
    },
    // M1 Integration fields
    m1_instance_id: {
      type: String,
      default: null,
      index: true, // For deduplication
    },
    m1_job_id: {
      type: String,
      default: null,
    },
    external_agent_id: {
      type: String,
      default: null,
    },
    call_state: {
      type: String,
      enum: ['CREATED', 'INGESTED', 'EVALUATED', 'FAILED'],
      default: 'CREATED',
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Indexes
callSchema.index({ workspaceId: 1 });
callSchema.index({ agentId: 1 });
callSchema.index({ teamId: 1 });
callSchema.index({ timestamp: 1 });
callSchema.index({ deletedAt: 1 });
callSchema.index({ m1_instance_id: 1, workspaceId: 1 }); // For M1 deduplication
callSchema.index({ contactId: 1 });

// Query helper
callSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

// Static method: Create or update call from M1 CALL_UPSERT (idempotent)
callSchema.statics.createOrUpdateFromM1Upsert = async function (workspaceId, m1Payload) {
  try {
    // Check for idempotency using m1_instance_id
    let call = await this.findOne({
      workspaceId,
      m1_instance_id: m1Payload.m1_instance_id,
    });

    // Build the metadata blob. Anything optional from M1 lives here so the
    // Call schema doesn't grow a column for every field the AI team adds.
    //
    // Notable absences:
    //   - audio_duration_sec   → owned by AI service, written via /result callback
    //   - audio_content_type   → replaced by audio_detected_mime (real, from bytes)
    //   - file_name            → replaced by display_name (cosmetic only)
    const buildMetadata = (existing = {}) => ({
      ...existing,
      raw_channel: m1Payload.raw_channel,
      raw_campaign: m1Payload.raw_campaign,
      raw_medium: m1Payload.raw_medium,
      raw_source: m1Payload.raw_source,
      audio_url: m1Payload.audio_url,
      caller_number: m1Payload.caller_number,
      notes: m1Payload.notes,
      scorecard_name: m1Payload.scorecard_name,
      scorecard_id: m1Payload.scorecard_id,
      // M1 ingestion audit
      external_call_id: m1Payload.external_call_id,
      display_name: m1Payload.display_name,
      language: m1Payload.language,
      audio_s3_key: m1Payload.audio_s3_key,
      audio_sha256: m1Payload.audio_sha256,
      audio_size_bytes: m1Payload.audio_size_bytes,
      audio_detected_mime: m1Payload.audio_detected_mime,
      audio_detected_extension: m1Payload.audio_detected_extension,
      recording_source: m1Payload.recording_source,
      consent_recorded: m1Payload.consent_recorded,
      import_batch_id: m1Payload.import_batch_id,
      is_duplicate: m1Payload.is_duplicate,
      duplicate_of_call_upload_id: m1Payload.duplicate_of_call_upload_id,
    });

    if (call) {
      // Update existing call (idempotent behavior). Duration is left untouched
      // here — it's set by the AI service result callback, not by M1 upsert.
      call.contactId = m1Payload.contactId || call.contactId;
      call.agentId = m1Payload.agentId || call.agentId;
      call.external_agent_id = m1Payload.external_agent_id || call.external_agent_id;
      call.timestamp = m1Payload.call_datetime || call.timestamp;
      call.direction = m1Payload.call_type === 'inbound' ? 'INBOUND' : 'OUTBOUND';
      call.source = 'M1_INGESTION';
      call.call_state = 'INGESTED';
      call.metadata = buildMetadata(call.metadata);

      await call.save();
      return { call, created: false };
    }

    // Create new call. Duration starts at 0; AI service updates it later.
    call = await this.create({
      workspaceId,
      contactId: m1Payload.contactId,
      agentId: m1Payload.agentId,
      external_agent_id: m1Payload.external_agent_id,
      m1_instance_id: m1Payload.m1_instance_id,
      m1_job_id: m1Payload.m1_job_id,
      direction: m1Payload.call_type === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      duration: 0,
      timestamp: m1Payload.call_datetime,
      source: 'M1_INGESTION',
      call_state: 'INGESTED',
      metadata: buildMetadata(),
    });

    return { call, created: true };
  } catch (error) {
    throw new Error(`Call.createOrUpdateFromM1Upsert failed: ${error.message}`);
  }
};

export const Call = mongoose.model('Call', callSchema);
