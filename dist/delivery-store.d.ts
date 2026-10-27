import type { HandlerContext } from './router.js';
import type { QqTurnReport } from './handlers/agent.js';
export type SavedInput = Pick<HandlerContext, 'scope' | 'userId' | 'groupId' | 'owner' | 'messageId' | 'payload' | 'replyTarget'>;
export interface DeliveryPart {
    text: string;
    kind: 'reply' | 'control';
    state: 'pending' | 'sending' | 'sent' | 'unknown';
    platformId?: string;
    error?: string;
}
export interface DeliveryTurn {
    id: string;
    input: SavedInput;
    state: 'waiting' | 'running' | 'output' | 'complete' | 'failed' | 'unknown';
    parts: DeliveryPart[];
    report?: QqTurnReport;
    notified?: boolean;
    sessionId?: string;
    retired?: boolean;
}
/** An unfinished generation is never replayed after a crash; only admitted
 * inputs and individually known-unsent text may be retried automatically. */
export declare class DeliveryStore {
    private readonly path?;
    readonly turns: Record<string, DeliveryTurn>;
    private tail;
    constructor(path?: string | undefined);
    open(): Promise<void>;
    save(): Promise<void>;
    accept(ctx: HandlerContext, output?: {
        sessionId: string;
        parts: DeliveryPart[];
    }): Promise<{
        turn: DeliveryTurn;
        duplicate: boolean;
    }>;
}
