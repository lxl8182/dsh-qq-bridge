export interface ActiveRoleInput {
    id: string;
    historyLength: number;
    historyId?: string;
}
export declare function installRoleOnlyPrompt(agentCtx: unknown, agentSession: unknown, persona: string, input: {
    current?: ActiveRoleInput;
}): void;
