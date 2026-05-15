import { z } from 'zod';
import { config } from '../config/index.js';

// Regex for email validation
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Workspace setup (post email-verification, requires setupToken)
export const setupWorkspaceSchema = z.object({
  workspaceName: z.string().min(1).max(64).trim(),
  industryType: z.enum(['Dental', 'Skin', 'Hair', 'Chiro', 'Other']),
  timezone: z.string().default('UTC'),
  languagesEnabled: z.array(z.string()).optional(),
  name: z.string().min(1).max(255).trim().optional(),
});

// New auth flow: email + password registration (no workspace yet)
export const registerSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(10).max(128),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

export const resendVerificationSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(10).max(128),
});

// Auth validation
export const loginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(10).max(128),
  name: z.string().min(1).max(255).trim().optional(),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string(),
});

// Invite validation
export const createInviteSchema = z.object({
  invites: z
    .array(
      z.object({
        email: z.string().email().toLowerCase().trim(),
        role: z.enum(['ADMIN', 'MANAGER', 'AGENT']),
        teamIds: z.array(z.string().min(1)),
      })
    )
    .min(1),
});

// Me / profile
export const updateMeSchema = z.object({
  name: z.string().min(1).max(255).trim(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10).max(128),
});

// Workspace update — admin can rename workspace, change timezone or languages
export const updateWorkspaceSchema = z
  .object({
    name: z.string().min(1).max(64).trim().optional(),
    timezone: z.string().min(1).max(64).optional(),
    languagesEnabled: z.array(z.string().min(2).max(10)).min(1).optional(),
  })
  .refine(
    (d) => d.name !== undefined || d.timezone !== undefined || d.languagesEnabled !== undefined,
    { message: 'At least one field (name, timezone, languagesEnabled) must be provided' }
  );

// Team validation
export const createTeamSchema = z.object({
  name: z.string().min(1).max(255).trim(),
});

export const updateTeamSchema = z.object({
  name: z.string().min(1).max(255).trim().optional(),
});

// User validation — admins/managers can only flip ACTIVE ↔ DISABLED here.
// PENDING_VERIFICATION / EMAIL_VERIFIED / INVITED are lifecycle states managed elsewhere.
export const updateUserSchema = z
  .object({
    role: z.enum(['ADMIN', 'MANAGER', 'AGENT']).optional(),
    teamIds: z.array(z.string().min(1)).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    // E.164 phone (e.g. +14155552671). Used by Twilio outbound to bridge calls.
    phone: z
      .string()
      .regex(/^\+[1-9]\d{1,14}$/, 'phone must be in E.164 format (e.g. +14155552671)')
      .nullable()
      .optional(),
    // Stable handle used by CSV ingestion to resolve external_agent_id rows.
    externalAgentId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine(
    (d) =>
      d.role !== undefined ||
      d.teamIds !== undefined ||
      d.status !== undefined ||
      d.phone !== undefined ||
      d.externalAgentId !== undefined,
    {
      message: 'At least one field (role, teamIds, status, phone, externalAgentId) must be provided',
    }
  );

// Settings validation
export const updatePermissionsSchema = z.object({
  managersCanEditScorecards: z.boolean().optional(),
  managersCanPublishScorecards: z.boolean().optional(),
  managersCanEditOutcomes: z.boolean().optional(),
  managersCanManageIntegrations: z.boolean().optional(),
  managersCanExportData: z.boolean().optional(),
  agentsCanViewOwnCallScores: z.boolean().optional(),
});

// Pagination validation
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const userFiltersSchema = paginationSchema.extend({
  role: z.enum(['ADMIN', 'MANAGER', 'AGENT']).optional(),
  status: z
    .enum(['PENDING_VERIFICATION', 'EMAIL_VERIFIED', 'INVITED', 'ACTIVE', 'DISABLED'])
    .optional(),
      teamId: z.string().optional(),
  // teamId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid teamId').optional(),
});

export const inviteFiltersSchema = paginationSchema.extend({
  status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED']).optional(),
});

export const auditLogsFiltersSchema = paginationSchema.extend({
  actionType: z.string().optional(),
});
