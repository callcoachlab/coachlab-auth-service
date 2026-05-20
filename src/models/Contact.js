import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Workspace',
      required: true,
    },
    phone: {
      type: String,
      required: true,
    },
    phone_e164: {
      type: String,
      required: true,
      index: true, // Index for quick lookups
    },
    external_agent_id: {
      type: String,
      default: null,
    },
    // Raw attribution fields from M1 ingestion
    raw_channel: {
      type: String,
      default: null,
    },
    raw_campaign: {
      type: String,
      default: null,
    },
    raw_medium: {
      type: String,
      default: null,
    },
    raw_source: {
      type: String,
      default: null,
    },
    // Attribution ownership (M0 owns these - M1 passes raw data only)
    matched_lead_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Lead',
      default: null,
    },
    attribution_source: {
      type: String,
      // null is valid (contact created before any attribution decision)
      enum: ['MANUAL', 'M1_IMPORT', 'AUTOMATIC_MATCH', null],
      default: null,
    },
    last_updated_by_m1_at: {
      type: Date,
      default: null,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index for workspace + phone_e164 lookup
contactSchema.index({ workspaceId: 1, phone_e164: 1 }, { unique: false });

// Query helper for active records
contactSchema.query.active = function () {
  return this.where({ deletedAt: null });
};

// Static method: Find or create contact from M1 CALL_UPSERT
contactSchema.statics.findOrCreateFromCallUpsert = async function (
  workspaceId,
  phone_e164,
  contactData = {}
) {
  try {
    // Try to find existing contact
    let contact = await this.findOne({
      workspaceId,
      phone_e164,
      deletedAt: null,
    });

    if (contact) {
      // Update with latest M1 data (raw attribution)
      if (contactData.external_agent_id) {
        contact.external_agent_id = contactData.external_agent_id;
      }
      if (contactData.raw_channel) {
        contact.raw_channel = contactData.raw_channel;
      }
      if (contactData.raw_campaign) {
        contact.raw_campaign = contactData.raw_campaign;
      }
      if (contactData.raw_medium) {
        contact.raw_medium = contactData.raw_medium;
      }
      if (contactData.raw_source) {
        contact.raw_source = contactData.raw_source;
      }
      contact.last_updated_by_m1_at = new Date();
      await contact.save();
      return { contact, created: false };
    }

    // Create new contact. attribution_source='M1_IMPORT' marks origin —
    // can be promoted to AUTOMATIC_MATCH or MANUAL later by attribution logic.
    contact = await this.create({
      workspaceId,
      phone: contactData.phone || phone_e164,
      phone_e164,
      external_agent_id: contactData.external_agent_id || null,
      raw_channel: contactData.raw_channel || null,
      raw_campaign: contactData.raw_campaign || null,
      raw_medium: contactData.raw_medium || null,
      raw_source: contactData.raw_source || null,
      attribution_source: 'M1_IMPORT',
      last_updated_by_m1_at: new Date(),
    });

    return { contact, created: true };
  } catch (error) {
    throw new Error(`Contact.findOrCreateFromCallUpsert failed: ${error.message}`);
  }
};

// Instance method: Update attribution from M1 data
contactSchema.methods.updateAttributionFromM1 = async function (m1Data) {
  if (m1Data.external_agent_id) {
    this.external_agent_id = m1Data.external_agent_id;
  }
  if (m1Data.raw_channel) {
    this.raw_channel = m1Data.raw_channel;
  }
  if (m1Data.raw_campaign) {
    this.raw_campaign = m1Data.raw_campaign;
  }
  if (m1Data.raw_medium) {
    this.raw_medium = m1Data.raw_medium;
  }
  if (m1Data.raw_source) {
    this.raw_source = m1Data.raw_source;
  }
  this.last_updated_by_m1_at = new Date();
  await this.save();
  return this;
};

export const Contact = mongoose.model('Contact', contactSchema);
