import type { DshQqBridgeConfig } from '../config.js';
import { type InboundImage } from '../onebot/images.js';
import type { Handler, HandlerContext } from '../router.js';
export type QqAgentRole = DshQqBridgeConfig['agent']['roles'][number];
type Attachment = NonNullable<InboundImage['attachment']>;
export type RoleChatContent = {
    type: 'text';
    text: string;
} | {
    type: 'image';
    attachment: Attachment;
};
export type RoleChatTurn = readonly RoleChatMessage[];
export interface RoleChatRunner {
    prepareImages(images: readonly InboundImage[]): Promise<InboundImage[]>;
    ensureRoleSession(sessionKey: string, role: QqAgentRole): Promise<string>;
    runRole(sessionKey: string, role: QqAgentRole, turn: RoleChatTurn): Promise<string>;
    archiveRoleSession(sessionKey: string, roleId: string, sessionId: string): Promise<void>;
    isSessionArchived?(sessionId: string): boolean;
    restoreSessions(sessions: readonly {
        sessionKey: string;
        sessionId: string;
    }[]): void;
}
interface RoleChatMessage {
    kind: 'user' | 'assistant';
    speaker: string;
    text: string;
    at: number;
    platformKey?: string;
    attachments?: Attachment[];
    delivery?: 'pending' | 'sent' | 'failed';
}
export declare function roleChatContent(message: RoleChatMessage): RoleChatContent[];
export declare function roleSessionKeyOf(sessionKey: string, roleId: string): string;
export declare function roleConfigurationError(roles: readonly QqAgentRole[]): string | undefined;
/** Each QQ chat has one transcript and four independently persisted DSH sessions. */
export declare class RoleChatCoordinator implements Handler {
    private readonly path;
    private readonly roles;
    private readonly runner;
    private readonly maxMessageLength;
    readonly name = "agent";
    private readonly conversations;
    private readonly queues;
    private writeTail;
    private stopped;
    constructor(path: string, roles: readonly QqAgentRole[], runner: RoleChatRunner, maxMessageLength: number);
    open(): Promise<void>;
    test(payload: string): boolean;
    run(ctx: HandlerContext): Promise<void>;
    dispose(): Promise<void>;
    private handleMessage;
    private sendReply;
    private ensureSession;
    private finishReset;
    private finishAll;
    private save;
}
export {};
