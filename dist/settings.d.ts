import { DshQqBridgeConfig } from './config.js';
export declare const QQ_BRIDGE_SETTINGS_NAMESPACE = "dsh-qq-bridge";
export declare const QQ_BRIDGE_NAPCAT_RPC_CHANNEL = "/dsh-qq-bridge-napcat";
export interface BridgeConfigRef {
    get(): unknown;
}
interface SettingsProvider {
    configure(options: {
        auto: boolean;
    }, owner?: unknown): () => void;
}
interface RpcConnection {
    rpc?: {
        handle(channel: string, handler: (endpoint: string, payload: unknown) => unknown | Promise<unknown>, options?: {
            authority?: 'loopback' | 'trusted-host';
        }): {
            dispose(): void;
        } | (() => void) | void;
    };
}
export interface QqBridgeSettingsCtx {
    fiber?: unknown;
    on?(event: string, callback: () => void): () => void;
    inject?(services: readonly string[], cb: (ctx: QqBridgeSettingsCtx & {
        settings?: SettingsProvider;
    }) => void, label?: string): {
        dispose(): void;
    } | void;
    settings?: SettingsProvider;
    connection?: RpcConnection;
    effect?(cb: () => void | (() => void), label?: string): void;
}
export interface InstalledQqBridgeSettings {
    current(): DshQqBridgeConfig;
    dispose(): void;
}
export declare const QqBridgeHostConfig: unknown;
export declare function readBridgeConfig(value: DshQqBridgeConfig | BridgeConfigRef): DshQqBridgeConfig;
export declare function installQqBridgeSettings(ctx: QqBridgeSettingsCtx, entry: DshQqBridgeConfig | BridgeConfigRef, onChange?: (next: DshQqBridgeConfig) => void | Promise<void>): Promise<InstalledQqBridgeSettings>;
export declare function cleanupLegacyProfileInsert(dshHome?: string): Promise<boolean>;
export {};
