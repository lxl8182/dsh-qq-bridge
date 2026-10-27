import { z } from 'zod';
declare const DshQqBridgeConfig: z.ZodObject<{
    /** Bundle 默认保持 inert；setup 或 Web 设置保存后显式启用。 */
    enabled: z.ZodDefault<z.ZodBoolean>;
    platform: z.ZodDefault<z.ZodEnum<["napcat", "official"]>>;
    napcat: z.ZodDefault<z.ZodObject<{
        /** NapCat 登录端 QQ；双号模式下与发送端 QQ 不同，仅用于 Web 设置页检测本机 NapCat。 */
        loginQq: z.ZodDefault<z.ZodNumber>;
        autoRestart: z.ZodDefault<z.ZodBoolean>;
        wsUrl: z.ZodDefault<z.ZodString>;
        token: z.ZodOptional<z.ZodString>;
        /** 连接失败时提示用户查看的安装向导文档路径(给 Agent 的指引)。 */
        guideDoc: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    }, "strip", z.ZodTypeAny, {
        loginQq: number;
        autoRestart: boolean;
        wsUrl: string;
        guideDoc: string;
        token?: string | undefined;
    }, {
        loginQq?: number | undefined;
        autoRestart?: boolean | undefined;
        wsUrl?: string | undefined;
        token?: string | undefined;
        guideDoc?: string | undefined;
    }>>;
    official: z.ZodDefault<z.ZodObject<{
        /** 腾讯 QQ 机器人开放平台 AppID。 */
        appId: z.ZodDefault<z.ZodString>;
        /** 腾讯 QQ 机器人开放平台 AppSecret。 */
        appSecret: z.ZodDefault<z.ZodString>;
        /** 管理员在该机器人下的 openid;用户需先给机器人发消息才能获得。 */
        adminOpenId: z.ZodDefault<z.ZodString>;
        /** 官方机器人模式下额外允许的用户 openid。 */
        allowlistOpenIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** 是否使用官方沙箱 API。 */
        sandbox: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        appId: string;
        appSecret: string;
        adminOpenId: string;
        allowlistOpenIds: string[];
        sandbox: boolean;
    }, {
        appId?: string | undefined;
        appSecret?: string | undefined;
        adminOpenId?: string | undefined;
        allowlistOpenIds?: string[] | undefined;
        sandbox?: boolean | undefined;
    }>>;
    access: z.ZodDefault<z.ZodObject<{
        adminQq: z.ZodNumber;
        allowlist: z.ZodDefault<z.ZodArray<z.ZodNumber, "many">>;
        commandPrefix: z.ZodDefault<z.ZodString>;
        mode: z.ZodDefault<z.ZodEnum<["whitelist", "open"]>>;
    }, "strip", z.ZodTypeAny, {
        mode: "whitelist" | "open";
        adminQq: number;
        allowlist: number[];
        commandPrefix: string;
    }, {
        adminQq: number;
        mode?: "whitelist" | "open" | undefined;
        allowlist?: number[] | undefined;
        commandPrefix?: string | undefined;
    }>>;
    agent: z.ZodDefault<z.ZodObject<{
        /** DSH Web 的 agent preset;存在 agentPresets 服务时默认挂 QQ bridge 专用 preset。 */
        preset: z.ZodDefault<z.ZodOptional<z.ZodString>>;
        /** 驱动 agent 的 provider 路由(须有已注册适配器)。 */
        provider: z.ZodDefault<z.ZodString>;
        /** 驱动 agent 的模型 id(provider 适配器解释)。 */
        model: z.ZodDefault<z.ZodString>;
        /**
         * 默认思考强度(provider 适配器的 effort id,如 low/medium/high/max)。
         *
         * 不同 provider 对"不传"的处理不一样:官方 deepseek 适配器自带默认值,而
         * 裸的 openai-completions provider 不传就完全不思考——同一个模型在 QQ 里
         * 会看起来"变笨了"。这里给一个显式默认,新会话与重启后都保持同一强度。
         * 留空则沿用适配器自己的行为,QQ 会话里仍可用 /reasoningEff 临时切换。
         */
        reasoningEffort: z.ZodOptional<z.ZodString>;
        /** 当 DSH llm 服务不可用时,bridge 侧 /models 的降级候选列表。 */
        models: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        /** QQ Agent 默认工作目录;支持 ~ 表示当前用户 home。 */
        cwd: z.ZodDefault<z.ZodString>;
        /** 是否边生成边回发 text 分段。默认 false:等待本轮完成后只回发最终回复。 */
        streamText: z.ZodDefault<z.ZodBoolean>;
        /** streamText=true 时,是否把思考过程(reasoning)也分段回发。默认 false。 */
        streamReasoning: z.ZodDefault<z.ZodBoolean>;
        /** 单条 QQ 消息最大长度(字符数);超长自动拆分为多条发送。QQ 官方单条约 5000 字,默认留余量。 */
        maxMessageLength: z.ZodDefault<z.ZodNumber>;
        /** 收到有效 QQ 指令后立即回发的确认消息;设为空字符串可关闭。 */
        ackMessage: z.ZodDefault<z.ZodString>;
        /** Agent 本轮最长等待时间(ms);未设置时不限制 QQ 对话等待时间。 */
        timeoutMs: z.ZodOptional<z.ZodNumber>;
        /** Agent 长时间无响应时回发的消息;仅设置 timeoutMs 后使用。 */
        timeoutMessage: z.ZodDefault<z.ZodString>;
        /**
         * 旧版「QQ 回复风格 skill」配置。
         *
         * 仅为配置兼容保留:桥接层不再拼装来源说明/风格标记,也不再自动调用 skill,
         * QQ 入站消息原文会逐字交给 Agent。该项当前的取值不影响发出的 payload。
         */
        qqReplyStyleSkill: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            skillName: z.ZodDefault<z.ZodString>;
        }, "strip", z.ZodTypeAny, {
            enabled: boolean;
            skillName: string;
        }, {
            enabled?: boolean | undefined;
            skillName?: string | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        model: string;
        preset: string;
        provider: string;
        models: string[];
        cwd: string;
        streamText: boolean;
        streamReasoning: boolean;
        maxMessageLength: number;
        ackMessage: string;
        timeoutMessage: string;
        qqReplyStyleSkill: {
            enabled: boolean;
            skillName: string;
        };
        reasoningEffort?: string | undefined;
        timeoutMs?: number | undefined;
    }, {
        reasoningEffort?: string | undefined;
        model?: string | undefined;
        preset?: string | undefined;
        provider?: string | undefined;
        models?: string[] | undefined;
        cwd?: string | undefined;
        streamText?: boolean | undefined;
        streamReasoning?: boolean | undefined;
        maxMessageLength?: number | undefined;
        ackMessage?: string | undefined;
        timeoutMs?: number | undefined;
        timeoutMessage?: string | undefined;
        qqReplyStyleSkill?: {
            enabled?: boolean | undefined;
            skillName?: string | undefined;
        } | undefined;
    }>>;
    shell: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
    }, {
        enabled?: boolean | undefined;
    }>>;
    notifications: z.ZodDefault<z.ZodObject<{
        agentReply: z.ZodDefault<z.ZodObject<{
            /** Agent 完成后是否主动向管理员发送提醒。不设置时 NapCat 默认开,官方机器人默认关。 */
            enabled: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            enabled?: boolean | undefined;
        }, {
            enabled?: boolean | undefined;
        }>>;
    }, "strip", z.ZodTypeAny, {
        agentReply: {
            enabled?: boolean | undefined;
        };
    }, {
        agentReply?: {
            enabled?: boolean | undefined;
        } | undefined;
    }>>;
    selfLogInput: z.ZodDefault<z.ZodObject<{
        /** 实验性:tail NapCat 日志中的 self-sent 消息,用于自己给自己发消息的单号场景。 */
        enabled: z.ZodDefault<z.ZodBoolean>;
        /** NapCat 日志路径;缺省按 ~/Napcat/log/napcat_<adminQq>.log 推导。 */
        logPath: z.ZodOptional<z.ZodString>;
        /** 轮询间隔(ms)。 */
        pollIntervalMs: z.ZodDefault<z.ZodNumber>;
        /** 启动时是否回放已有日志;默认只处理启动后的新行,避免误触发历史消息。 */
        replayOnStart: z.ZodDefault<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        enabled: boolean;
        pollIntervalMs: number;
        replayOnStart: boolean;
        logPath?: string | undefined;
    }, {
        enabled?: boolean | undefined;
        logPath?: string | undefined;
        pollIntervalMs?: number | undefined;
        replayOnStart?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    official: {
        appId: string;
        appSecret: string;
        adminOpenId: string;
        allowlistOpenIds: string[];
        sandbox: boolean;
    };
    agent: {
        model: string;
        preset: string;
        provider: string;
        models: string[];
        cwd: string;
        streamText: boolean;
        streamReasoning: boolean;
        maxMessageLength: number;
        ackMessage: string;
        timeoutMessage: string;
        qqReplyStyleSkill: {
            enabled: boolean;
            skillName: string;
        };
        reasoningEffort?: string | undefined;
        timeoutMs?: number | undefined;
    };
    napcat: {
        loginQq: number;
        autoRestart: boolean;
        wsUrl: string;
        guideDoc: string;
        token?: string | undefined;
    };
    enabled: boolean;
    platform: "official" | "napcat";
    access: {
        mode: "whitelist" | "open";
        adminQq: number;
        allowlist: number[];
        commandPrefix: string;
    };
    shell: {
        enabled: boolean;
    };
    notifications: {
        agentReply: {
            enabled?: boolean | undefined;
        };
    };
    selfLogInput: {
        enabled: boolean;
        pollIntervalMs: number;
        replayOnStart: boolean;
        logPath?: string | undefined;
    };
}, {
    official?: {
        appId?: string | undefined;
        appSecret?: string | undefined;
        adminOpenId?: string | undefined;
        allowlistOpenIds?: string[] | undefined;
        sandbox?: boolean | undefined;
    } | undefined;
    agent?: {
        reasoningEffort?: string | undefined;
        model?: string | undefined;
        preset?: string | undefined;
        provider?: string | undefined;
        models?: string[] | undefined;
        cwd?: string | undefined;
        streamText?: boolean | undefined;
        streamReasoning?: boolean | undefined;
        maxMessageLength?: number | undefined;
        ackMessage?: string | undefined;
        timeoutMs?: number | undefined;
        timeoutMessage?: string | undefined;
        qqReplyStyleSkill?: {
            enabled?: boolean | undefined;
            skillName?: string | undefined;
        } | undefined;
    } | undefined;
    napcat?: {
        loginQq?: number | undefined;
        autoRestart?: boolean | undefined;
        wsUrl?: string | undefined;
        token?: string | undefined;
        guideDoc?: string | undefined;
    } | undefined;
    enabled?: boolean | undefined;
    platform?: "official" | "napcat" | undefined;
    access?: {
        adminQq: number;
        mode?: "whitelist" | "open" | undefined;
        allowlist?: number[] | undefined;
        commandPrefix?: string | undefined;
    } | undefined;
    shell?: {
        enabled?: boolean | undefined;
    } | undefined;
    notifications?: {
        agentReply?: {
            enabled?: boolean | undefined;
        } | undefined;
    } | undefined;
    selfLogInput?: {
        enabled?: boolean | undefined;
        logPath?: string | undefined;
        pollIntervalMs?: number | undefined;
        replayOnStart?: boolean | undefined;
    } | undefined;
}>;
export type DshQqBridgeConfig = z.infer<typeof DshQqBridgeConfig>;
export { DshQqBridgeConfig };
