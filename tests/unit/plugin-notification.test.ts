import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode-ai/plugin";
import plugin from "../../src/index";

function createPluginContext(prompt: (input: unknown) => unknown): Parameters<Plugin>[0] {
    return {
        client: {
            session: {
                prompt,
            },
        },
        project: {},
        directory: "/tmp/opencode-interceptor-test",
        worktree: "/tmp/opencode-interceptor-test",
        experimental_workspace: {
            register: () => undefined,
        },
        serverUrl: new URL("http://127.0.0.1:4099"),
        $: {},
    } as unknown as Parameters<Plugin>[0];
}

describe("plugin command notifications", () => {
    test("ignored command replies retain live agent, variant, and model params", async () => {
        let promptInput: unknown;
        const hooks = await plugin(
            createPluginContext((input) => {
                promptInput = input;
            }),
        );

        await hooks["chat.message"]?.(
            {
                sessionID: "session-params",
                agent: "build",
                variant: "plan",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-sonnet-4-6",
                },
            },
            { message: {} as never, parts: [] },
        );

        await expect(
            hooks["command.execute.before"]?.(
                {
                    command: "intercept",
                    sessionID: "session-params",
                    arguments: "",
                },
                { parts: [] },
            ),
        ).rejects.toThrow("__OPENCODE_INTERCEPTOR_COMMAND_HANDLED__:intercept");

        expect(promptInput).toEqual({
            path: { id: "session-params" },
            body: {
                noReply: true,
                agent: "build",
                variant: "plan",
                model: {
                    providerID: "anthropic",
                    modelID: "claude-sonnet-4-6",
                },
                parts: [
                    {
                        type: "text",
                        text: expect.stringContaining("## Interceptor Status"),
                        ignored: true,
                    },
                ],
            },
        });
    });
});
