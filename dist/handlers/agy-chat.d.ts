import type { InboundImage } from '../onebot/images.js';
export type ChatLine = {
    role: 'user' | 'assistant';
    content: string;
};
export declare class AgyChats {
    private readonly model;
    private readonly effort;
    private readonly chats;
    private stopped;
    constructor(model: string, effort: string);
    run(key: string, history: () => readonly ChatLine[], input: string, owner: boolean, timeoutMs?: number, images?: readonly InboundImage[]): Promise<string>;
    reset(key: string): void;
    dispose(): void;
}
