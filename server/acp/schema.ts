import { z } from "zod";

/**
 * Zod schemas and TypeScript types for the Agent Client Protocol (ACP)
 * as implemented by Antigravity CLI (`agy acp` 1.5.0+).
 *
 * All schemas use `.passthrough()` to remain forward-compatible with
 * additional agy vendor fields or future protocol revisions.
 */

// ============================================================================
// 1. Usage & Prompt Results
// ============================================================================

export const acpUsageSchema = z
  .object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedReadTokens: z.number().optional(),
    cachedWriteTokens: z.number().optional(),
    thoughtTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  })
  .passthrough();

export type AcpUsage = z.infer<typeof acpUsageSchema>;

export const acpPromptResultSchema = z
  .object({
    stopReason: z.string(),
    usage: acpUsageSchema.optional(),
  })
  .passthrough();

export type AcpPromptResult = z.infer<typeof acpPromptResultSchema>;

export type AcpPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType?: string; data?: string; uri?: string; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

// ============================================================================
// 2. Initialize
// ============================================================================

export const acpInitializeResultSchema = z
  .object({
    protocolVersion: z.number(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    promptCapabilities: z
      .object({
        image: z.boolean().optional(),
        embeddedContext: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    sessionCapabilities: z
      .object({
        resume: z.boolean().optional(),
        close: z.boolean().optional(),
        load: z.boolean().optional(),
        list: z.boolean().optional(),
        additionalDirectories: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    _meta: z
      .object({
        antigravity: z
          .object({
            tier: z.string().optional(),
            systemPrompt: z
              .object({
                append: z.boolean().optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z
      .array(
        z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type AcpInitializeResult = z.infer<typeof acpInitializeResultSchema>;

// ============================================================================
// 3. Sessions (new / resume)
// ============================================================================

export const acpModelInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
  })
  .passthrough();

export type AcpModelInfo = z.infer<typeof acpModelInfoSchema>;

export const acpModeInfoSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export type AcpModeInfo = z.infer<typeof acpModeInfoSchema>;

export const acpConfigOptionSchema = z
  .object({
    id: z.string(),
    type: z.string().optional(),
    currentValue: z.unknown().optional(),
    options: z
      .array(
        z
          .object({
            value: z.string(),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type AcpConfigOption = z.infer<typeof acpConfigOptionSchema>;

export const acpNewSessionResultSchema = z
  .object({
    sessionId: z.string(),
    models: z
      .object({
        availableModels: z.array(acpModelInfoSchema).optional(),
        currentModelId: z.string().optional(),
      })
      .passthrough()
      .optional(),
    modes: z
      .object({
        currentModeId: z.string().optional(),
        availableModes: z.array(acpModeInfoSchema).optional(),
      })
      .passthrough()
      .optional(),
    configOptions: z.array(acpConfigOptionSchema).optional(),
    _meta: z
      .object({
        antigravity: z
          .object({
            tier: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AcpNewSessionResult = z.infer<typeof acpNewSessionResultSchema>;

export const acpResumeSessionResultSchema = z
  .object({
    sessionId: z.string().optional(),
  })
  .passthrough();

export type AcpResumeSessionResult = z.infer<typeof acpResumeSessionResultSchema>;

// ============================================================================
// 4. Session Updates (streamed notifications)
// ============================================================================

export const acpTextContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

export type AcpTextContent = z.infer<typeof acpTextContentSchema>;

export const acpDiffContentSchema = z
  .object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().optional(),
    newText: z.string().optional(),
  })
  .passthrough();

export type AcpDiffContent = z.infer<typeof acpDiffContentSchema>;

export const acpToolLocationSchema = z
  .object({
    path: z.string(),
  })
  .passthrough();

export const acpToolCallUpdateSchema = z
  .object({
    sessionUpdate: z.union([z.literal("tool_call"), z.literal("tool_call_update")]),
    toolCallId: z.string(),
    status: z.union([
      z.literal("pending"),
      z.literal("in_progress"),
      z.literal("completed"),
      z.literal("failed"),
      z.string(),
    ]),
    kind: z.string().optional(),
    title: z.string().optional(),
    locations: z.array(acpToolLocationSchema).optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.array(z.record(z.string(), z.unknown())).optional(),
    // agy vendor fields
    name: z.string().optional(),
    args: z.unknown().optional(),
  })
  .passthrough();

export type AcpToolCallUpdate = z.infer<typeof acpToolCallUpdateSchema>;

export const acpMessageChunkUpdateSchema = z
  .object({
    sessionUpdate: z.union([
      z.literal("user_message_chunk"),
      z.literal("agent_message_chunk"),
      z.literal("agent_thought_chunk"),
    ]),
    content: acpTextContentSchema,
  })
  .passthrough();

export type AcpMessageChunkUpdate = z.infer<typeof acpMessageChunkUpdateSchema>;

export const acpAvailableCommandsUpdateSchema = z
  .object({
    sessionUpdate: z.literal("available_commands_update"),
    availableCommands: z.array(
      z
        .object({
          name: z.string(),
          description: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type AcpAvailableCommandsUpdate = z.infer<typeof acpAvailableCommandsUpdateSchema>;

export const acpCurrentModeUpdateSchema = z
  .object({
    sessionUpdate: z.literal("current_mode_update"),
    currentModeId: z.string(),
  })
  .passthrough();

export type AcpCurrentModeUpdate = z.infer<typeof acpCurrentModeUpdateSchema>;

export const acpConfigOptionUpdateSchema = z
  .object({
    sessionUpdate: z.literal("config_option_update"),
    configOptions: z.array(acpConfigOptionSchema),
  })
  .passthrough();

export type AcpConfigOptionUpdate = z.infer<typeof acpConfigOptionUpdateSchema>;

export const acpSessionInfoUpdateSchema = z
  .object({
    sessionUpdate: z.literal("session_info_update"),
    title: z.string().optional(),
  })
  .passthrough();

export type AcpSessionInfoUpdate = z.infer<typeof acpSessionInfoUpdateSchema>;

export const acpGenericSessionUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
  })
  .passthrough();

export type AcpGenericSessionUpdate = z.infer<typeof acpGenericSessionUpdateSchema>;

export type AcpSessionUpdate =
  | AcpMessageChunkUpdate
  | AcpToolCallUpdate
  | AcpAvailableCommandsUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpSessionInfoUpdate
  | AcpGenericSessionUpdate;

export const acpSessionUpdateNotificationSchema = z
  .object({
    sessionId: z.string(),
    update: acpGenericSessionUpdateSchema,
  })
  .passthrough();

export type AcpSessionUpdateNotification = z.infer<typeof acpSessionUpdateNotificationSchema>;

// ============================================================================
// 5. Incoming Agent Requests (Permissions & Elicitations)
// ============================================================================

export const acpPermissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.union([
      z.literal("allow_once"),
      z.literal("allow_always"),
      z.literal("reject_once"),
      z.literal("reject_always"),
      z.string(),
    ]),
  })
  .passthrough();

export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;

export const acpRequestPermissionParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCall: z.unknown().optional(),
    options: z.array(acpPermissionOptionSchema),
  })
  .passthrough();

export type AcpRequestPermissionParams = z.infer<typeof acpRequestPermissionParamsSchema>;

export type AcpRequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }
  | { outcome: string; [key: string]: unknown };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}

export const acpElicitationParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCallId: z.string().optional(),
    mode: z.string(),
    message: z.string().optional(),
    requestedSchema: z
      .object({
        type: z.literal("object").optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AcpElicitationParams = z.infer<typeof acpElicitationParamsSchema>;

export type AcpElicitationResult =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline" }
  | { action: "cancel" };
