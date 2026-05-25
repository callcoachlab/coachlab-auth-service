import axios from 'axios';
import { Call } from '../models/Call.js';
import { logger } from '../config/logger.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const M1_BASE_URL = process.env.M1_BASE_URL || process.env.M1_API_URL || null;
const M0_INTERNAL_SECRET = process.env.M0_INTERNAL_SECRET || null;

// QA routing thresholds — configurable via env, sensible defaults for prod
const QA_SCORE_THRESHOLD = parseFloat(process.env.QA_SCORE_THRESHOLD || '60');
const QA_CONFIDENCE_THRESHOLD = parseFloat(process.env.QA_CONFIDENCE_THRESHOLD || '0.75');
const QA_SAMPLING_RATE = parseFloat(process.env.QA_SAMPLING_RATE || '0.05'); // 5% random sample

/**
 * Determine whether a call should go to QA queue or auto-pass.
 *
 * A call goes to NEEDS_REVIEW if ANY of:
 *   1. AI explicitly flagged needsReview: true
 *   2. Total score < threshold (default 60)
 *   3. AI confidence < threshold (default 0.75)
 *   4. Any section contains a criterion with isCriticalFail: true and result: 'FAIL'
 *   5. Random sampling (5% of auto-passing calls still get reviewed)
 */
function resolveCallState(body) {
  const { status, score, confidence, needsReview } = body;

  if (status === 'FAILED') return 'FAILED';

  // AI explicitly requested review
  if (needsReview === true) return 'NEEDS_REVIEW';

  // Low score
  if (score?.total != null && score.total < QA_SCORE_THRESHOLD) return 'NEEDS_REVIEW';

  // Low AI confidence
  if (confidence != null && confidence < QA_CONFIDENCE_THRESHOLD) return 'NEEDS_REVIEW';

  // Critical fail hit anywhere in breakdown
  const hasCriticalFailure = score?.breakdown?.some((section) =>
    section.criteria?.some((c) => c.isCriticalFail && c.result === 'FAIL')
  );
  if (hasCriticalFailure) return 'NEEDS_REVIEW';

  // Random QA sample (deterministic within this request — not truly random per call,
  // but fine for sampling purposes at volume)
  if (Math.random() < QA_SAMPLING_RATE) return 'NEEDS_REVIEW';

  return 'EVALUATED';
}

/**
 * Notify M1 that the AI result has arrived so it can mark the CallUpload COMPLETED.
 * Fire-and-forget — we don't block the AI callback response on M1's acknowledgement.
 */
async function notifyM1Completed({ callUploadId, m0CallId, callState }) {
  if (!M1_BASE_URL || !callUploadId) return;

  try {
    await axios.post(
      `${M1_BASE_URL}/internal/ai-result-notify`,
      { callUploadId, m0CallId, callState },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(M0_INTERNAL_SECRET && { Authorization: `Bearer ${M0_INTERNAL_SECRET}` }),
        },
        timeout: 5000,
      }
    );
    logger.info({ action: 'M1_NOTIFY_SENT', callUploadId, m0CallId, callState });
  } catch (err) {
    // Non-fatal — M1 can reconcile stale SENT_TO_AI uploads on a cron if needed.
    logger.warn({
      action: 'M1_NOTIFY_FAILED',
      callUploadId,
      m0CallId,
      error: err.message,
    });
  }
}

/**
 * POST /internal/calls/:callId/result
 *
 * Called by the AI scoring service after it finishes processing a call.
 * Parses and persists the structured result, routes the call to QA queue
 * or auto-pass, then pings M1 to advance the CallUpload lifecycle.
 *
 * Idempotent: re-posting the same result replaces the previous one.
 *
 * Expected body:
 * {
 *   callUploadId:  string   (M1 CallUpload._id — echoed so we can notify M1)
 *   status:        'EVALUATED' | 'FAILED'
 *   duration:      number   (seconds — AI measured from audio)
 *   transcript:    { language, text, segments: [{ speaker, start, end, text }] }
 *   score: {
 *     total:       number (0-100)
 *     breakdown: [{
 *       sectionName: string
 *       sectionScore: number
 *       criteria: [{
 *         criteriaId, criteriaText, result ('PASS'|'FAIL'|'NA'|'PARTIAL'),
 *         score, maxScore, confidence, isCriticalFail,
 *         evidence: { quote, startTime, endTime, speaker }
 *       }]
 *     }]
 *   }
 *   flags:         [{ type, message, startTime, endTime }]
 *   confidence:    number (0-1)  overall AI confidence
 *   needsReview:   boolean      AI explicitly requests human review
 *   processingMs:  number
 *   modelVersion:  string
 *   failureReason: string (only for status='FAILED')
 * }
 */
export const submitCallResult = asyncHandler(async (req, res) => {
  const workspaceId = req.workspaceId;
  const { callId } = req.params;
  const {
    callUploadId,
    status,
    duration,
    transcript,
    score,
    flags,
    confidence,
    needsReview,
    processingMs,
    modelVersion,
    failureReason,
  } = req.body;

  if (!status || !['EVALUATED', 'FAILED'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'status must be one of: EVALUATED, FAILED',
      },
    });
  }

  const call = await Call.findOne({ _id: callId, workspaceId, deletedAt: null });

  if (!call) {
    return res.status(404).json({
      success: false,
      error: { code: 'CALL_NOT_FOUND', message: 'Call not found in this workspace' },
    });
  }

  // Determine final state via QA routing logic
  const resolvedState = resolveCallState({
    status,
    score,
    confidence,
    needsReview,
  });

  // Write duration if AI measured it (authoritative source)
  if (typeof duration === 'number' && duration > 0) {
    call.duration = duration;
  }

  call.call_state = resolvedState;

  // Write structured result subdoc — replaces any previous result on re-post
  call.result = {
    score: score?.total ?? null,
    breakdown: score?.breakdown ?? [],
    transcript: transcript
      ? {
          language: transcript.language ?? null,
          text: transcript.text ?? null,
          segments: transcript.segments ?? [],
        }
      : call.result?.transcript ?? {},
    flags: flags ?? [],
    confidence: confidence ?? null,
    needsReview: resolvedState === 'NEEDS_REVIEW',
    failureReason: failureReason ?? null,
    processingMs: processingMs ?? null,
    modelVersion: modelVersion ?? null,
    evaluatedAt: new Date(),
  };

  // Preserve M1 ingestion metadata; don't overwrite with nulls
  call.metadata = {
    ...call.metadata,
    ai_result_received_at: new Date(),
    ...(callUploadId && { call_upload_id: callUploadId }),
  };

  await call.save();

  logger.info({
    action: 'AI_RESULT_RECEIVED',
    workspaceId,
    callId: call._id,
    callUploadId,
    status,
    resolvedState,
    score: score?.total ?? null,
    confidence: confidence ?? null,
    needsReview: resolvedState === 'NEEDS_REVIEW',
    flagCount: flags?.length ?? 0,
    duration,
    modelVersion,
  });

  // Notify M1 — fire and forget, don't block response
  notifyM1Completed({
    callUploadId: callUploadId || call.m1_call_upload_id,
    m0CallId: call._id.toString(),
    callState: resolvedState,
  });

  return res.json({
    success: true,
    data: {
      callId: call._id.toString(),
      call_state: resolvedState,
      needsReview: resolvedState === 'NEEDS_REVIEW',
    },
  });
});
