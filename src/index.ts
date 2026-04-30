import type { Plugin } from "@opencode-ai/plugin";
import { executeInterceptCommand } from "./intercept/command";
import { INTERCEPT_COMMAND_NAME } from "./intercept/constants";
import { installInterceptFetch } from "./intercept/fetch";
import { cleanupExpiredInterceptArtifacts } from "./intercept/retention";
import { recordInterceptAnomaly, refreshActiveInterceptSession } from "./intercept/state";

const HANDLED_SENTINEL = "__OPENCODE_INTERCEPTOR_COMMAND_HANDLED__";

type NotificationRequest = {
    path: { id: string };
    body: {
        noReply: true;
        agent?: string;
        model?: {
            providerID: string;
            modelID: string;
        };
        variant?: string;
        parts: Array<{
            type: "text";
            text: string;
            ignored: true;
        }>;
    };
};

type PluginSessionClient = {
    prompt?: (input: NotificationRequest) => Promise<unknown> | unknown;
    promptAsync?: (input: NotificationRequest) => Promise<unknown>;
};

type LiveNotificationParams = {
    agent?: string;
    variant?: string;
    model?: {
        providerID: string;
        modelID: string;
    };
};

const liveNotificationParamsBySession = new Map<string, LiveNotificationParams>();

type ChatMessageInput = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["chat.message"]>>[0];
type ChatParamsInput = Parameters<NonNullable<Awaited<ReturnType<Plugin>>["chat.params"]>>[0];

function extractLiveNotificationParams(input: {
    agent?: string;
    variant?: string;
    model?: { providerID?: string; modelID?: string };
}): LiveNotificationParams {
    return {
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.model?.providerID && input.model.modelID
            ? { model: { providerID: input.model.providerID, modelID: input.model.modelID } }
            : {}),
    };
}

function rememberLiveNotificationParams(
    sessionId: string | undefined,
    input: ChatMessageInput | ChatParamsInput,
): void {
    if (!sessionId) {
        return;
    }

    const next = {
        ...(liveNotificationParamsBySession.get(sessionId) ?? {}),
        ...extractLiveNotificationParams(input),
    };

    liveNotificationParamsBySession.set(sessionId, next);
}

async function sendIgnoredMessage(
    ctx: Parameters<Plugin>[0],
    sessionId: string,
    text: string,
    params: LiveNotificationParams = {},
) {
    const session = ctx.client.session as PluginSessionClient | undefined;
    const request: NotificationRequest = {
        path: { id: sessionId },
        body: {
            noReply: true,
            ...params,
            parts: [{ type: "text", text, ignored: true }],
        },
    };

    if (typeof session?.prompt === "function") {
        await Promise.resolve(session.prompt(request));
        return;
    }

    if (typeof session?.promptAsync === "function") {
        await session.promptAsync(request);
        return;
    }

    throw new Error("OpenCode session prompt API is unavailable for ignored replies.");
}

function syncActiveSession(sessionId?: string | null): void {
    refreshActiveInterceptSession(sessionId);
}

function throwHandledSentinel(): never {
    throw new Error(`${HANDLED_SENTINEL}:${INTERCEPT_COMMAND_NAME}`);
}

function safeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const plugin: Plugin = async (ctx) => {
    try {
        const cleanup = await cleanupExpiredInterceptArtifacts();
        for (const warning of cleanup.warnings) {
            recordInterceptAnomaly({
                scope: "cleanup",
                phase: warning.phase,
                message: warning.message,
            });
        }
    } catch (error) {
        recordInterceptAnomaly({
            scope: "cleanup",
            phase: "startup",
            message: `Unexpected cleanup failure: ${safeErrorMessage(error)}`,
        });
    }

    installInterceptFetch();

    return {
        config: async (config) => {
            config.command = {
                ...(config.command ?? {}),
                [INTERCEPT_COMMAND_NAME]: {
                    template: INTERCEPT_COMMAND_NAME,
                    description:
                        "Show interception status or toggle the local HTTP interception scaffold.",
                },
            };
        },
        "chat.message": async (input) => {
            syncActiveSession(input.sessionID);
            rememberLiveNotificationParams(input.sessionID, input);
        },
        "chat.params": async (input) => {
            syncActiveSession(input.sessionID);
            rememberLiveNotificationParams(input.sessionID, input);
        },
        "command.execute.before": async (input) => {
            if (input.command !== INTERCEPT_COMMAND_NAME) {
                return;
            }

            syncActiveSession(input.sessionID);
            await sendIgnoredMessage(
                ctx,
                input.sessionID,
                executeInterceptCommand({
                    argumentsText: input.arguments,
                    sessionId: input.sessionID,
                }),
                liveNotificationParamsBySession.get(input.sessionID) ?? {},
            );
            throwHandledSentinel();
        },
    };
};

export default plugin;
