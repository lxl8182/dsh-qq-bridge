import { type RoleChatTurn } from './role-chat.js';
export interface ActiveRoleInput {
    id: string;
    transcript: RoleChatTurn;
    staleNodes?: number[];
}
export declare function installRoleOnlyPrompt(agentCtx: unknown, agentSession: unknown, persona: string, input: {
    current?: ActiveRoleInput;
}): void;
