import { OnebotClient, WsTransport } from './onebot/client.js';
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { MessageRouter } from './router.js';
import { AccessGate } from './security.js';
import { AgentRpcHandler } from './handlers/agent.js';
import { DshAgentExecutor, eventsForTurn, extractAssistantText, isUnexecutedDsmlToolCall } from './handlers/dsh-executor.js';
import { DIR_COMMAND, resolveUserPath } from './handlers/directory.js';
import { createSetCwdControlHandler, createNewSessionControlHandler, createSetModelControlHandler, createSetPermissionControlHandler, createSetReasoningEffortControlHandler, QqControlDispatcher, } from './handlers/control.js';
import { createSaveMemoControlHandler, LazyCustomMemoryStore } from './handlers/custom-memory.js';
import { createScheduleTaskControlHandler, InMemoryTaskScheduler } from './handlers/scheduler.js';
import { BridgeControlHandler, installBridgeModelSelection, HELP_COMMAND, MODEL_COMMAND, MODELS_COMMAND, NEW_SESSION_COMMAND, PERMISSION_COMMAND, PERMISSIONS_COMMAND, REASONING_EFFORT_COMMAND, } from './handlers/model-control.js';
import { ShellHandler } from './handlers/shell.js';
import { NapcatSelfLogInput } from './inputs/napcat-log.js';
import { homedir } from 'node:os';
import { TencentOfficialBotClient } from './official/client.js';
import { QqInteractionBridge } from './interactions.js';
import { DshWebActivityGate } from './web-activity.js';
import { installQqBridgeSettings, readBridgeConfig, QqBridgeHostConfig } from './settings.js';
import { isNapcatSelfKeepAliveMessage } from './onebot/self-keepalive.js';
import { NapcatRecovery } from './napcat-recovery.js';
import { probeNapcatLogin } from './napcat-tags.js';
import { QQ_BRIDGE_EVENTS_SERVICE, QqBridgeEvents } from './bridge-events.js';
/**
 * Cordis 插件入口(Host 侧)。
 * M3:每个 QQ 会话持有常驻 DSH live agent,实现多轮上下文。
 * 依赖:agentLoop / agentPresets / sessionQuery。
 */
export const Config = QqBridgeHostConfig;
export const name = 'dsh-qq-bridge';
export const inject = ['agentLoop', 'agentPresets', 'sessionQuery'];
export async function apply(ctx, options) {
    console.info('请到Web UI的设置中配置<QQ bridge>');
    const entry = readBridgeConfig(options);
    // One service for the whole plugin, published before the runtime so an
    // observer that subscribes during the same boot cannot miss the first turn.
    const events = new QqBridgeEvents();
    const disposeEvents = ctx
        .provide?.(QQ_BRIDGE_EVENTS_SERVICE, events);
    const runtime = createBridgeRuntime(ctx, events);
    const settings = await installQqBridgeSettings(ctx, options, (next) => runtime.reconcile(next));
    if (settings === undefined)
        await runtime.reconcile(entry);
    return async () => {
        settings?.dispose();
        await runtime.dispose();
        events.dispose();
        if (typeof disposeEvents === 'function')
            disposeEvents();
    };
}
function createBridgeRuntime(ctx, events) {
    let stop;
    let activeKey = '';
    let revision = 0;
    return {
        async reconcile(cfg) {
            const nextRevision = ++revision;
            const nextKey = JSON.stringify(cfg);
            if (!isBridgeConfigured(cfg)) {
                if (stop) {
                    const previous = stop;
                    stop = undefined;
                    activeKey = '';
                    await previous();
                }
                return;
            }
            if (stop && activeKey === nextKey)
                return;
            if (stop) {
                const previous = stop;
                stop = undefined;
                activeKey = '';
                await previous();
            }
            try {
                const nextStop = await startQqBridge(ctx, cfg, events);
                if (nextRevision !== revision) {
                    await nextStop();
                    return;
                }
                stop = nextStop;
                activeKey = nextKey;
            }
            catch (err) {
                activeKey = '';
                console.warn(`[dsh-qq-bridge] failed to start QQ bridge from saved settings: ${err instanceof Error ? err.message : String(err)}`);
            }
        },
        async dispose() {
            revision += 1;
            if (!stop)
                return;
            const previous = stop;
            stop = undefined;
            activeKey = '';
            await previous();
        },
    };
}
async function startQqBridge(ctx, cfg, events) {
    events?.setOutputLimit(cfg.agent.maxMessageLength);
    assertPlatformConfig(cfg);
    const officialMode = cfg.platform === 'official';
    if (events)
        events.platform = cfg.platform;
    const adminTarget = officialMode ? cfg.official.adminOpenId : cfg.access.adminQq;
    const gate = new AccessGate({
        adminQq: cfg.access.adminQq,
        adminId: adminTarget,
        allowlist: officialMode ? cfg.official.allowlistOpenIds : cfg.access.allowlist,
        commandPrefix: cfg.access.commandPrefix,
        mode: cfg.access.mode,
    });
    const client = createBridgeClient(cfg);
    const notifyAgentReply = agentReplyNotificationsEnabled(cfg);
    const replyNotifier = notifyAgentReply
        ? createAgentReplyNotifier(ctx, client, adminTarget)
        : () => { };
    const outbound = async (scope, targetId, text, replyTarget) => {
        if (scope === 'private')
            await client.sendPrivate(targetId, text, replyTarget);
        else
            await client.sendGroup(targetId, text, replyTarget);
    };
    // The receipt variant returns whatever platform message id the transport
    // reports; a transport that reports none is not an error, it just leaves the
    // accepted part without an id.
    const outboundWithReceipt = async (scope, targetId, text, replyTarget) => {
        const result = scope === 'private'
            ? await client.sendPrivate(targetId, text, replyTarget)
            : await client.sendGroup(targetId, text, replyTarget);
        const platformId = readPlatformMessageId(result);
        return platformId === undefined ? {} : { platformId };
    };
    const interactions = new QqInteractionBridge(outbound, cfg.access.commandPrefix);
    const unregisterInteractions = interactions.register(ctx);
    const webActivity = DshWebActivityGate.register(ctx);
    const router = new MessageRouter(gate, outbound, interactions, outboundWithReceipt);
    const workspaceAttachment = createWorkspaceAttachment(ctx);
    const llmAccess = createDshLlmAccess(ctx);
    const commandsAccess = createDshCommandsAccess(ctx);
    const storageDomainAccess = createDshStorageDomainAccess(ctx);
    const customMemoryStore = new LazyCustomMemoryStore(storageDomainAccess.current);
    const executor = makeDshExecutor(ctx, cfg.agent, interactions, workspaceAttachment.attach, llmAccess.current, commandsAccess.current);
    const taskScheduler = new InMemoryTaskScheduler({
        executor,
        store: customMemoryStore,
        maxMessageLength: cfg.agent.maxMessageLength,
        send: async (target, text) => {
            await outbound(target.scope, target.targetId, text);
        },
    });
    taskScheduler.startScanning();
    const controlDispatcher = new QqControlDispatcher();
    controlDispatcher.register(createSetCwdControlHandler(executor));
    controlDispatcher.register(createNewSessionControlHandler(executor));
    controlDispatcher.register(createSetModelControlHandler(executor));
    controlDispatcher.register(createSetReasoningEffortControlHandler(executor));
    controlDispatcher.register(createSetPermissionControlHandler(executor));
    controlDispatcher.register(createSaveMemoControlHandler(customMemoryStore));
    controlDispatcher.register(createScheduleTaskControlHandler(taskScheduler));
    const unregisterBridgeControl = router.register(new BridgeControlHandler(executor, executor, executor, executor));
    let unregisterShell = () => { };
    if (cfg.shell.enabled) {
        unregisterShell = router.register(new ShellHandler(async (cmd) => ({ stdout: `(shell exec disabled) ${cmd}`, code: 1 })));
    }
    const accountKey = createHash('sha256').update(JSON.stringify([cfg.platform, adminTarget,
        officialMode ? cfg.official.appId : cfg.napcat.wsUrl])).digest('hex').slice(0, 24);
    const profile = ctx.get ? ctx.get('profileContext') : ctx.profileContext;
    const agentHandler = new AgentRpcHandler(executor, {
        deliveryStatePath: join(profile?.home ?? join(homedir(), '.dsh'), 'plugins', 'dsh-qq-bridge', accountKey, 'delivery.json'),
        restoreContext: input => {
            const evt = { post_type: 'message', message_type: input.scope, user_id: input.userId,
                group_id: input.groupId, raw_message: input.payload, message_id: input.messageId };
            if (!gate.allow(evt))
                return undefined;
            const target = input.scope === 'private' ? input.userId : input.groupId;
            return { ...input, owner: gate.isOwner(evt),
                respond: text => outbound(input.scope, target, text, input.replyTarget),
                send: text => outboundWithReceipt(input.scope, target, text, input.replyTarget) };
        },
        prepareTurn: input => events?.prepare(input) ?? Promise.resolve(),
        waitForOutput: async (sessionKey) => {
            const sessionId = executor.currentSessionId(sessionKey);
            if (sessionId)
                await events?.waitForOutput(sessionId);
        },
        maxMessageLength: cfg.agent.maxMessageLength,
        ackMessage: cfg.agent.ackMessage,
        timeoutMs: cfg.agent.timeoutMs,
        timeoutMessage: cfg.agent.timeoutMessage,
        // 旧配置项透传只为兼容;AgentRpcHandler 不再用它拼 prompt 或调 skill。
        qqReplyStyleSkill: cfg.agent.qqReplyStyleSkill,
        webActivityGate: webActivity.gate,
        sessionIdOf: (sessionKey) => executor.currentSessionId(sessionKey),
        ...(events ? { observeTurn: (report) => events.publish({
                ...report,
                // The executor knows the session id only after it has one; report what is
                // true at publication time rather than the id it will have later.
                ...(report.sessionId === undefined && executor.currentSessionId(report.sessionKey) !== undefined
                    ? { sessionId: executor.currentSessionId(report.sessionKey) } : {}),
            }) } : {}),
        reservedCommands: [
            DIR_COMMAND,
            HELP_COMMAND,
            NEW_SESSION_COMMAND,
            MODELS_COMMAND,
            MODEL_COMMAND,
            REASONING_EFFORT_COMMAND,
            PERMISSION_COMMAND,
            PERMISSIONS_COMMAND,
        ],
        controlDispatcher,
    });
    await agentHandler.open();
    const disposeSessionOutput = registerQqSessionOutput(ctx, executor, events, agentHandler);
    const disposeRetirer = events?.setRetirer(async (sessionId) => {
        await agentHandler.retireSession(sessionId);
        await executor.retireSessionId(sessionId);
    });
    const disposeReplay = events?.setReplay(() => agentHandler.completedReports());
    const disposeOutputSender = events?.setOutputSender(async (sessionId, outputId, parts, canSend) => {
        const input = events.binding(sessionId);
        if (!input)
            throw new Error('QQ owner session is not bound');
        return agentHandler.deliverOutput(input, outputId, parts, canSend);
    });
    // RO04-B 接口钩子:只接线,不新增判断,也不在启动时触发任何恢复或会话创建。
    // 两者都在插槽里,后注册覆盖先注册;events.dispose() 在卸载时清空。
    events?.setIdentityVerifier(record => gate.isOwner({ user_id: record.userId }));
    events?.setSessionBinder(record => executor.prepareSession(record.sessionKey));
    // 主动推送通道:其他插件(例如记忆插件)有"没人可回填"的结果时,直接发到
    // 管理员私聊。发给谁、怎么发由桥接决定,调用方只给文字。
    const disposePusher = events?.setPusher
        ? events.setPusher(async (text) => { await client.sendPrivate(adminTarget, text); })
        : undefined;
    const unregisterAgent = router.register(agentHandler);
    const retryTimer = setInterval(() => {
        void agentHandler.retryPending().catch(err => console.warn(`[dsh-qq-bridge] delivery recovery failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 15000);
    retryTimer.unref();
    // 连接健康检查失败不应拖垮整个 DSH Host 的插件挂载。
    // NapCat 模式保持静默并在后台自动重连；官方模式仍输出连接引导。
    // 依旧保持插件挂载(WS 端点在时才真正收发),避免瞬时断连导致整棵 tree 回滚。
    let recovery;
    const unsubMessages = client.onMessage((evt) => {
        recovery?.observeOnline();
        if (!officialMode && isNapcatSelfKeepAliveMessage(evt.raw_message))
            return;
        void router.route(evt);
    });
    client.connect().catch((err) => {
        if (officialMode)
            console.warn(buildOfficialConnectGuidance(cfg, err));
    });
    const loginQq = cfg.napcat.loginQq || cfg.access.adminQq;
    recovery = officialMode ? undefined : new NapcatRecovery({
        qq: loginQq,
        enabled: cfg.napcat.autoRestart,
        logPath: cfg.selfLogInput.logPath?.trim() || `${homedir()}/Napcat/log/napcat_${loginQq}.log`,
        probe: async () => {
            if (!await probeNapcatLogin(cfg.napcat.wsUrl, cfg.napcat.token ?? '', loginQq)) {
                throw new Error('NapCat 未报告当前账号在线');
            }
        },
    });
    await recovery?.start();
    let selfLogInput;
    if (!officialMode && cfg.selfLogInput.enabled) {
        const logPath = cfg.selfLogInput.logPath?.trim() || `${homedir()}/Napcat/log/napcat_${cfg.access.adminQq}.log`;
        selfLogInput = new NapcatSelfLogInput({
            logPath,
            selfQq: cfg.access.adminQq,
            commandPrefix: cfg.access.commandPrefix,
            pollIntervalMs: cfg.selfLogInput.pollIntervalMs,
            replayOnStart: cfg.selfLogInput.replayOnStart,
        });
        selfLogInput.start((evt) => {
            if (isNapcatSelfKeepAliveMessage(evt.raw_message))
                return;
            recovery?.observeOnline();
            void router.route(evt);
        }).catch((err) => {
            console.warn(`[dsh-qq-bridge] self log input failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
    return async () => {
        clearInterval(retryTimer);
        disposeSessionOutput();
        disposeRetirer?.();
        disposeReplay?.();
        disposeOutputSender?.();
        disposePusher?.();
        await agentHandler.dispose();
        unregisterAgent();
        unregisterBridgeControl();
        unregisterShell();
        unregisterInteractions();
        webActivity.dispose();
        llmAccess.dispose();
        commandsAccess.dispose();
        storageDomainAccess.dispose();
        workspaceAttachment.dispose();
        taskScheduler.dispose();
        recovery?.stop();
        await customMemoryStore.close();
        unsubMessages();
        replyNotifier();
        selfLogInput?.stop();
        await executor.disposeAll(); // 释放全部常驻 agent
        await client.disconnect();
    };
}
export default { name, inject, Config, apply };
/** 判断是否启用 agent 完成后的管理员主动提醒。 */
export function agentReplyNotificationsEnabled(cfg) {
    return cfg.notifications.agentReply.enabled ?? cfg.platform !== 'official';
}
/**
 * 从一个平台动作响应里取出消息 id。
 *
 * 官方 SDK 返回对象里 id 的键名随版本变化(c2c/group 都可能带 `id`、
 * `messageId` 或 `msgId`),NapCat 用 OneBot 的 `data.message_id`。这里只做只读
 * 提取:取不到就是取不到,不合成假 id。
 */
export function readPlatformMessageId(result) {
    if (typeof result === 'string')
        return result.trim() || undefined;
    if (typeof result !== 'object' || result === null)
        return undefined;
    const record = result;
    const data = typeof record.data === 'object' && record.data !== null
        ? record.data
        : undefined;
    for (const candidate of [record.messageId, record.msgId, record.id,
        data?.message_id, data?.messageId, data?.msgId, data?.id]) {
        if (typeof candidate === 'string' && candidate.trim())
            return candidate.trim();
        if (typeof candidate === 'number' && Number.isFinite(candidate))
            return String(candidate);
    }
    return undefined;
}
export function makeDshExecutor(ctx, agentCfg, interactions, attachWorkspace, llm, commands) {
    const handles = wireDsh(ctx, agentCfg, interactions, attachWorkspace);
    const modelOptions = {
        defaultCwd: agentCfg?.cwd ? resolveUserPath(agentCfg.cwd) : undefined,
        defaultProvider: agentCfg?.provider,
        defaultModel: agentCfg?.model,
        defaultReasoningEffort: agentCfg?.reasoningEffort,
        models: agentCfg?.models,
        resolveModelSelection: createModelSelectionResolver(llm),
        listModels: createModelLister(llm),
        executeCommand: createDshCommandExecutor(commands),
    };
    if (handles)
        return new DshAgentExecutor(handles, modelOptions);
    // 无 DSH 服务时占位,便于纯 CLI / 测试
    const fallback = {
        async getOrCreate() {
            return { followup() { }, async whenIdle() { }, async dispose() { } };
        },
        async deliver() { },
        async readSurface() {
            return [];
        },
    };
    return new DshAgentExecutor(fallback, modelOptions);
}
/** 把真实 DSH 服务包装成 executor 所需的句柄。 */
function wireDsh(ctx, agentCfg, interactions, attachWorkspace) {
    const loop = ctx.agentLoop;
    if (!loop)
        return undefined;
    const query = ctx.sessionQuery;
    return {
        async getOrCreate(options) {
            void options.sessionKey;
            if (ctx.agentPresets && agentCfg?.preset) {
                console.info(`[dsh-qq-bridge] mounting agent preset "${agentCfg.preset}" for ${options.sessionId}`);
            }
            else if (agentCfg?.preset) {
                console.warn(`[dsh-qq-bridge] agent preset "${agentCfg.preset}" requested but agentPresets service is unavailable`);
            }
            const cwd = options.cwd ?? workdir();
            const handle = await loop.createAgent(ctx, {
                sessionId: options.sessionId,
                // agent 的 model 路由必须显式给出,否则 prompt 组装时 `{{model}}` 无值。
                agentOptions: {
                    provider: options.modelSelection.current.provider,
                    model: options.modelSelection.current.model,
                    ...(options.modelSelection.current.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: options.modelSelection.current.reasoningEffort }),
                },
                meta: { cwd, ...(agentCfg?.preset ? { agentPreset: agentCfg.preset } : {}) },
                ...(ctx.agentPresets && agentCfg?.preset
                    ? {
                        setup: async (agentCtx) => {
                            installBridgeModelSelection(agentCtx, options.modelSelection);
                            await ctx.agentPresets.mount(agentCtx, agentCfg.preset);
                        },
                    }
                    : { setup: (agentCtx) => void installBridgeModelSelection(agentCtx, options.modelSelection) }),
            });
            await attachWorkspace?.(options.sessionId, cwd);
            interactions?.bindAgent(options.sessionKey, handle.agent);
            // 捕获 live session 对象:用于 session/event 过滤(流式分段)。
            const session = handle.agent.session;
            return {
                followup(message) {
                    handle.agent.followup(message);
                },
                async whenIdle() {
                    await handle.agent.whenIdle();
                },
                async readSurface() {
                    // rc.3 的完整日志含 turn/start/end；模型 surface 只有消息，不能用于定位轮次。
                    return session.snapshotEvents();
                },
                async dispose() {
                    await handle.dispose();
                },
                _session: session,
                _commandAgent: handle.agent,
            };
        },
        async deliver(agent, prompt, onChunk, images) {
            // DSH 要求 user message 是「identified」的:必须带 id、role、source.kind。
            // 缺失 id 或 source 用 type 而非 kind,会在 session 校验时抛 「lacks an identified message」。
            //
            // 图片必须先经 attachments.saveImages() 取得持久引用,再以
            // { type: 'image', attachment } 进 content;直接塞 base64 会被 DSH 的
            // 内容校验拒绝。图片准入失败时退回纯文本,不让整轮失败。
            const content = await buildDshUserContent(ctx, prompt, images);
            const msg = {
                id: randomUUID(),
                role: 'user',
                content,
                source: { kind: 'user' },
            };
            // 流式分段:订阅该会话的 session/event,按「句子边界 + 最大长度」聚合后回发。
            // 注意:text-delta 是逐 token 到达,若按时间窗批量会在 QQ 刷出单个词;
            // 改为累积到完整句子/段落再回发,兼顾及时性与可读性。
            let unsubscribe;
            const textBuf = [];
            const reasoningBuf = [];
            const sessionId = agent._session?.id;
            const MIN_FLUSH = 8; // 最少多少字符才值得单独发一条
            const MAX_FLUSH = 200; // 无标点时最多攒多少字符强制发
            const sentenceBoundary = /[。！？!?；;\n]$/;
            const flushText = () => {
                if (textBuf.length === 0)
                    return;
                const text = textBuf.splice(0).join('');
                if (text && onChunk)
                    onChunk(text, 'text');
            };
            const flushReasoning = () => {
                if (reasoningBuf.length === 0)
                    return;
                const text = reasoningBuf.splice(0).join('');
                if (text && onChunk)
                    onChunk(text, 'reasoning');
            };
            if (onChunk && ctx.on) {
                unsubscribe = ctx.on('session/event', (subject, evt) => {
                    if (sessionId === undefined || subject?.id !== sessionId)
                        return;
                    const chunk = evt.data?.chunk;
                    if (!chunk)
                        return;
                    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                        textBuf.push(chunk.text);
                        const joined = textBuf.join('');
                        // 句子边界或超长时回发一条完整段落
                        if ((joined.length >= MIN_FLUSH && sentenceBoundary.test(joined)) || joined.length >= MAX_FLUSH) {
                            flushText();
                        }
                    }
                    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                        reasoningBuf.push(chunk.text);
                        const joined = reasoningBuf.join('');
                        if ((joined.length >= MIN_FLUSH && sentenceBoundary.test(joined)) || joined.length >= MAX_FLUSH) {
                            flushReasoning();
                        }
                    }
                });
            }
            agent.followup(msg);
            try {
                await agent.whenIdle();
            }
            catch (err) {
                // 调试图:turn 失败时落盘完整会话日志 + 错误详情。
                try {
                    const fs = await import('node:fs');
                    const dir = '/home/liangyihao/temp/dsh-qq-bridge';
                    fs.writeFileSync(`${dir}/.debug-turn-error.json`, JSON.stringify({
                        error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
                        delivered: msg,
                    }, null, 2));
                    const events = agent.readSurface;
                    if (typeof events === 'function') {
                        const evts = await events();
                        fs.writeFileSync(`${dir}/.debug-turn-log.json`, JSON.stringify(evts, null, 2));
                    }
                }
                catch { /* noop */ }
                flushReasoning();
                flushText(); // 先把已收集的分段发出去,再抛错
                unsubscribe?.();
                throw err;
            }
            flushReasoning();
            flushText(); // 收尾冲刷剩余内容
            unsubscribe?.();
            return { messageId: msg.id };
        },
        async prepareImages(images) {
            const admitted = [];
            for (const image of images) {
                const attachment = await saveInboundImage(ctx, image);
                if (attachment)
                    admitted.push({ ...image, attachment });
            }
            return admitted;
        },
        async readSurface(sessionId) {
            if (!query)
                return [];
            const snap = await query.readSession(sessionId);
            return snap.events;
        },
    };
}
function createModelSelectionResolver(llm) {
    return async (selection) => {
        const runtime = llm?.();
        if (!runtime?.resolveCallConfig)
            return selection;
        const resolved = await runtime.resolveCallConfig(selection);
        return {
            provider: resolved.provider,
            model: resolved.model,
            ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
        };
    };
}
function createModelLister(llm) {
    return async (provider) => {
        const runtime = llm?.();
        if (!runtime?.listModels)
            return [];
        const models = await runtime.listModels(provider).catch(() => []);
        return await Promise.all(models.map(async (model) => {
            const base = {
                provider: model.provider ?? provider,
                id: model.id,
                name: model.name,
            };
            if (!runtime.resolveModelInfo)
                return base;
            try {
                const resolved = await runtime.resolveModelInfo(provider, model.id);
                const reasoning = resolved.reasoning;
                if (!reasoning)
                    return base;
                return {
                    ...base,
                    reasoningEfforts: reasoning.efforts.map(effort => effort.id),
                    ...(reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: reasoning.defaultEffort }),
                };
            }
            catch {
                return base;
            }
        }));
    };
}
function createDshCommandExecutor(commands) {
    return async (agent, line) => {
        const runtime = commands?.();
        if (!runtime?.execute)
            return undefined;
        const execution = await runtime.execute(agent, line, [], new AbortController().signal);
        const result = execution?.result;
        if (!result)
            return undefined;
        const text = result.text?.trim();
        if (result.kind === 'error')
            return `权限命令执行失败: ${text || 'unknown error'}`;
        if (text)
            return `权限命令执行成功: ${text}`;
        return '权限命令执行成功。';
    };
}
function createDshLlmAccess(ctx) {
    let llm;
    const disposers = [];
    if (ctx.inject) {
        const fiber = ctx.inject(['llm'], (childCtx) => {
            const scoped = childCtx;
            const current = scoped.llm;
            llm = current;
            scoped.effect?.(() => () => {
                if (llm === current)
                    llm = undefined;
            }, 'dsh-qq-bridge.llm');
        }, 'dsh-qq-bridge.llm');
        if (fiber && typeof fiber === 'object' && typeof fiber.dispose === 'function') {
            disposers.push(() => fiber.dispose());
        }
    }
    else {
        llm = ctx.llm;
    }
    return {
        current() {
            return llm;
        },
        dispose() {
            llm = undefined;
            for (const dispose of disposers.splice(0))
                dispose();
        },
    };
}
function createDshCommandsAccess(ctx) {
    let commands;
    const disposers = [];
    if (ctx.inject) {
        const fiber = ctx.inject(['commands'], (childCtx) => {
            const scoped = childCtx;
            const current = scoped.commands;
            commands = current;
            scoped.effect?.(() => () => {
                if (commands === current)
                    commands = undefined;
            }, 'dsh-qq-bridge.commands');
        }, 'dsh-qq-bridge.commands');
        if (fiber && typeof fiber === 'object' && typeof fiber.dispose === 'function') {
            disposers.push(() => fiber.dispose());
        }
    }
    else {
        commands = ctx.commands;
    }
    return {
        current() {
            return commands;
        },
        dispose() {
            commands = undefined;
            for (const dispose of disposers.splice(0))
                dispose();
        },
    };
}
function createDshStorageDomainAccess(ctx) {
    let storageDomain;
    const disposers = [];
    if (ctx.inject) {
        const fiber = ctx.inject(['storageDomain'], (childCtx) => {
            const scoped = childCtx;
            const current = scoped.storageDomain;
            storageDomain = current;
            scoped.effect?.(() => () => {
                if (storageDomain === current)
                    storageDomain = undefined;
            }, 'dsh-qq-bridge.storageDomain');
        }, 'dsh-qq-bridge.storageDomain');
        if (fiber && typeof fiber === 'object' && typeof fiber.dispose === 'function') {
            disposers.push(() => fiber.dispose());
        }
    }
    else {
        storageDomain = ctx.storageDomain;
    }
    return {
        current() {
            return storageDomain;
        },
        dispose() {
            storageDomain = undefined;
            for (const dispose of disposers.splice(0))
                dispose();
        },
    };
}
function createWorkspaceAttachment(ctx) {
    let registry;
    const disposers = [];
    if (ctx.inject) {
        const fiber = ctx.inject(['workspaceRegistry'], (childCtx) => {
            const scoped = childCtx;
            const current = scoped.workspaceRegistry;
            registry = current;
            scoped.effect?.(() => () => {
                if (registry === current)
                    registry = undefined;
            }, 'dsh-qq-bridge.workspaceRegistry');
        }, 'dsh-qq-bridge.workspaceRegistry');
        if (fiber && typeof fiber === 'object' && typeof fiber.dispose === 'function') {
            disposers.push(() => fiber.dispose());
        }
    }
    else {
        registry = ctx.workspaceRegistry;
    }
    return {
        async attach(sessionId, cwd) {
            const active = registry;
            if (!active)
                return;
            await attachSessionToWorkspace(active, sessionId, cwd);
        },
        dispose() {
            for (const dispose of disposers.splice(0))
                dispose();
            registry = undefined;
        },
    };
}
/**
 * 把一张已下载的入站图片交给 DSH 的附件存储,换回持久引用。
 *
 * DSH 的图片准入要求 `{ data: Uint8Array, mediaType }`,并会自己做规范化
 * (解码、尺寸校验、可能的压缩)。这里不做任何图片处理,只做类型转换。
 * @param ctx - 提供 `attachments` 服务的宿主上下文。
 * @param image - base64 编码的入站图片。
 * @returns 持久引用;宿主没有附件服务或准入拒绝时返回 undefined。
 */
async function saveInboundImage(ctx, image) {
    const attachments = ctx.get?.('attachments');
    if (!attachments?.saveImages)
        return undefined;
    try {
        const refs = await attachments.saveImages([{
                data: new Uint8Array(Buffer.from(image.data, 'base64')),
                mediaType: image.mediaType,
                ...(image.name === undefined ? {} : { name: image.name }),
            }]);
        const ref = refs?.[0];
        if (!ref || typeof ref.attachmentId !== 'string')
            return undefined;
        return { attachmentId: ref.attachmentId, ...ref };
    }
    catch (error) {
        // 准入拒绝(超限/类型不符)只影响这张图;文本照常送达。
        console.warn(`[dsh-qq-bridge] image admission rejected: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
/**
 * 组装本轮交给 DSH 的用户消息内容。
 *
 * 文本块在前、图片块在后。任何一张图准入失败都只是少了那一块,不会退回整条
 * 消息;没有任何可发内容时(空文本且没有图片)仍保留一个空文本块,让 DSH 报它
 * 自己的「empty prompt」,而不是桥接层悄悄吞掉这一轮。
 * @param ctx - 宿主上下文,用于取得附件服务。
 * @param text - 用户原话。
 * @param images - 已下载的入站图片。
 * @returns DSH 可接收的内容块数组。
 */
async function buildDshUserContent(ctx, text, images) {
    const content = [];
    if (text.length > 0)
        content.push({ type: 'text', text });
    for (const image of images ?? []) {
        const attachment = image.attachment ?? await saveInboundImage(ctx, image);
        if (!attachment)
            continue;
        content.push({ type: 'image', attachment });
    }
    if (content.length === 0)
        content.push({ type: 'text', text });
    return content;
}
export async function attachSessionToWorkspace(registry, sessionId, cwd) {
    try {
        const workspace = await registry.create(cwd);
        await workspace.attachSession(sessionId);
    }
    catch (err) {
        console.warn(`[dsh-qq-bridge] failed to attach session ${sessionId} to workspace ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function workdir() {
    try {
        return process.cwd();
    }
    catch {
        return '.';
    }
}
function createBridgeClient(cfg) {
    if (cfg.platform === 'official') {
        return new TencentOfficialBotClient({
            appId: cfg.official.appId,
            appSecret: cfg.official.appSecret,
            sandbox: cfg.official.sandbox,
        });
    }
    const transport = new WsTransport(cfg.napcat.wsUrl, cfg.napcat.token);
    return new OnebotClient(transport);
}
function assertPlatformConfig(cfg) {
    if (cfg.platform !== 'official')
        return;
    if (!cfg.official.appId.trim())
        throw new Error('dsh-qq-bridge: official.appId is required when platform=official');
    if (!cfg.official.appSecret.trim())
        throw new Error('dsh-qq-bridge: official.appSecret is required when platform=official');
    if (cfg.access.mode === 'whitelist' && !cfg.official.adminOpenId.trim()) {
        throw new Error('dsh-qq-bridge: official.adminOpenId is required in whitelist mode');
    }
}
function isBridgeConfigured(cfg) {
    if (!cfg.enabled)
        return false;
    if (cfg.platform === 'official') {
        if (!cfg.official.appId.trim())
            return false;
        if (!cfg.official.appSecret.trim())
            return false;
        return cfg.access.mode !== 'whitelist' || cfg.official.adminOpenId.trim() !== '';
    }
    return cfg.access.adminQq > 0;
}
/** Forward completed followups only for sessions bound by an admitted QQ input. */
export function registerQqSessionOutput(ctx, executor, bridge, handler) {
    if (!ctx.on || !bridge)
        return () => { };
    return ctx.on('session/event', (session, event) => {
        if (!isCompletedTurnEnd(event) || session.header?.origin === 'subagent')
            return;
        const sessionId = session.id;
        if (!sessionId)
            return;
        const binding = bridge.binding(sessionId);
        if (!binding || executor.currentSessionId(binding.sessionKey) !== sessionId)
            return;
        const turn = eventsForTurn(session.snapshotEvents(), event.data.turn);
        // Ordinary QQ inputs already have their own HandlerContext and send path.
        if (turn.some(row => {
            const input = row;
            return input.type === 'user/message' && ['user', 'companion-proactive'].includes((input.data?.message ?? input.data)?.source?.kind ?? '');
        }))
            return;
        const text = extractAssistantText(turn);
        if (!text || isUnexecutedDsmlToolCall(text))
            return;
        void handler.sendSessionOutput(binding, event.data.turn, text).catch(error => {
            console.warn(`[dsh-qq-bridge] session output delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    });
}
export function createAgentReplyNotifier(ctx, client, adminTarget) {
    if (!ctx.on || adminTarget === '' || adminTarget === 0)
        return () => { };
    const sent = new Set();
    return ctx.on('session/event', (session, event) => {
        if (!isCompletedTurnEnd(event))
            return;
        if (session.header?.origin === 'subagent')
            return;
        const sessionId = String(session.id ?? '');
        if (isQqAgentSessionId(sessionId) || sessionId.startsWith('companion-spell-'))
            return;
        const key = `${sessionId}:${event.data.turn}`;
        if (sent.has(key))
            return;
        const title = findSessionTitle(session.snapshotEvents());
        sendAgentReplyNotification(client, adminTarget, sent, key, `主人，您收到一条Agent回复，来自[${title}]`);
    });
}
/** 监听 DSH 会话完成事件,向管理员 QQ 发送一条轻量提醒。 */
export function registerAgentReplyNotifier(ctx, client, adminTarget) {
    return createAgentReplyNotifier(ctx, client, adminTarget);
}
function sendAgentReplyNotification(client, adminTarget, sent, key, message) {
    if (sent.has(key))
        return;
    sent.add(key);
    void client.sendPrivate(adminTarget, message).catch((err) => {
        console.warn(`[dsh-qq-bridge] agent reply notification failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}
function isQqAgentSessionId(sessionId) {
    return sessionId.startsWith('qq-');
}
function isCompletedTurnEnd(event) {
    const evt = event;
    return evt?.type === 'turn/end'
        && typeof evt.data?.turn === 'number'
        && evt.data.reason?.kind === 'completed';
}
export function findSessionTitle(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event?.type === 'session/title' && typeof event.data?.title === 'string')
            return event.data.title;
    }
    return '';
}
/** 构建官方机器人连接失败时的引导文案。 */
export function buildOfficialConnectGuidance(cfg, err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
        `[dsh-qq-bridge] 无法连接腾讯官方 QQ 机器人 WebSocket: appId=${cfg.official.appId || '(empty)'}`,
        `原因: ${reason}`,
        ``,
        `请检查:`,
        `1. QQ 开放平台机器人 AppID/AppSecret 是否正确。`,
        `2. 机器人是否已加入沙箱成员,或已上线到当前会话场景。`,
        `3. 当前服务器出口 IP 是否满足开放平台白名单要求。`,
        `4. whitelist 模式下 official.adminOpenId 是否来自该机器人收到的真实消息事件。`,
    ].join('\n');
}
/** 构建连接失败时的引导文案,指向「给 Agent 的 NapCat 安装向导」。 */
export function buildConnectGuidance(cfg, err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [
        `[dsh-qq-bridge] 无法连接 onebot WS 端点: ${cfg.napcat.wsUrl}`,
        `原因: ${reason}`,
        ``,
        `请按以下步骤让 QQ 接入(NapCat 是一侧部署,插件只负责连接):`,
        `1. 阅读给 Agent 的安装向导:${cfg.napcat.guideDoc ?? 'docs/agent-napcat-guide.md'}`,
        `2. 若尚未安装 NapCat,引导用户在官方 GitHub (NapNeko/NapCatQQ) 下载并扫码登录专属小号。`,
        `3. 启用正向 WebSocket,核对端口与 wsUrl(${cfg.napcat.wsUrl})一致。`,
        `4. 连接成功后,从主号向机器人小号发送「${formatCommandExample(cfg.access.commandPrefix, 'ping')}」验证双向通信。`,
    ].join('\n');
}
function formatCommandExample(commandPrefix, payload) {
    const prefix = commandPrefix.trim();
    return prefix ? `${prefix} ${payload}` : payload;
}
