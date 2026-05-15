import { Call } from '../models/Call.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

/**
 * POST /internal/calls/:callId/result
 *
 * Endpoint the AI scoring service POSTs to once it has finished processing
 * a call. We DO NOT do scoring here — we just persist whatever the AI team
 * sends us against the existing Call record.
 *
 * Body (all optional except status):
 *   {
 *     workspaceId: required (validated by middleware),
 *     status: 'EVALUATED' | 'FAILED' | 'NEEDS_REVIEW',
 *     transcript: { text, language, segments?: [{ speaker, start, end, text }] },
 *     score: { total, sections: [{ name, criteria: [{ key, result, confidence, evidence }] }] },
 *     flags: [{ type, message, evidence? }],
 *     failureReason: string (only for status='FAILED')
 *   }
 *
 * Idempotent: re-posting the same result for the same callId is allowed.
 */
export const submitCallResult = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { callId } = req.params;
  const { status, transcript, score, flags, failureReason } = req.body;

  if (!status || !['EVALUATED', 'FAILED', 'NEEDS_REVIEW'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'status must be one of: EVALUATED, FAILED, NEEDS_REVIEW',
      },
    });
  }

  const call = await Call.findOne({
    _id: callId,
    workspaceId,
    deletedAt: null,
  });

  if (!call) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'CALL_NOT_FOUND',
        message: 'Call does not exist in this workspace',
      },
    });
  }

  call.call_state = status === 'EVALUATED' ? 'EVALUATED' : status === 'FAILED' ? 'FAILED' : 'INGESTED';

  // We store AI output blob in metadata — schema for transcript/score/flags
  // is owned by the AI team, so we don't impose a strict shape here.
  call.metadata = {
    ...call.metadata,
    ...(transcript && { transcript }),
    ...(score && { score }),
    ...(flags && { flags }),
    ...(failureReason && { failureReason }),
    ai_result_received_at: new Date(),
  };

  await call.save();

  logger.info({
    action: 'INTERNAL_CALL_RESULT',
    workspaceId,
    callId: call._id,
    status,
    hasTranscript: !!transcript,
    hasScore: !!score,
    flagCount: flags?.length || 0,
  }, 'AI scoring result received');

  res.json({
    success: true,
    data: {
      callId: call._id.toString(),
      call_state: call.call_state,
    },
  });
});
