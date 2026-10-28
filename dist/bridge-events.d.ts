/**
 * 桥接层对其他 Host 插件暴露的最小事实出口。
 *
 * 记忆插件需要知道「这一轮是不是主人说的、真实输入是什么、最终发出去的文字
 * 是什么、QQ 平台接受到哪几段、对应哪个 DSH 会话」。这些事实只有桥接层知道,
 * 所以由一个只读服务发布,而不是让别的插件去解析 QQ 协议或猜 DSH 事件。
 *
 * 边界:
 * - 只暴露事实,不暴露桥接内部状态、凭据、原始出站文本队列或修改入口;
 * - 服务名固定,结构变化必须留旧字段(新增是可加,删除是破坏);
 * - 桥接未加载时这个服务不存在,订阅方必须自己处理缺失。
 */
import type { QqTurnReport } from './handlers/agent.js';
export interface QqTurnInput {
    sessionKey: string;
    sessionId?: string;
    scope: 'private' | 'group';
    owner: boolean;
    userId: string | number;
    groupId?: string | number;
    messageId?: string | number;
    input: string;
}
/**
 * 一次已校验拥有者绑定的持久事实(RO04-B)。
 *
 * 只有桥接自己确认过的东西才进这里:拥有者身份来自配置里的 admin 身份
 * (AccessGate.isOwner),会话键由 scope + 平台 id 生成。昵称、群名片和
 * 会话前缀都不是身份来源,所以这里没有它们的字段;没有绑定就等真实入站,
 * 不从历史文本里猜一个人出来。
 *
 * 这张记录是身份事实,不是会话:DSH 会话 id 每次启动都会变,所以恢复时先
 * 还原这张记录,再把本进程新的会话 id 挂上去(bindSession)。
 */
export interface QqBindingRecord {
    /** 'private:<userId>' 或 'group:<groupId>',必须等于桥接自己的生成规则。 */
    sessionKey: string;
    scope: 'private' | 'group';
    /** 恒为 true:个人绑定只跟随已校验的拥有者。 */
    owner: true;
    userId: string | number;
    groupId?: string | number;
    /** 确认该绑定的入站平台消息 id,仅用于事后核对。 */
    messageId?: string | number;
    /** 调用方持久化时可原样带回;桥接不用它做任何时间判断。 */
    observedAt?: number;
}
/** 通用投递请求里的一段:索引由调用方/核心固定,桥接不再二次切分。 */
export interface QqDeliveryPart {
    index: number;
    text: string;
}
/**
 * 通用投递请求(RO04-B)。
 *
 * 正文可以来自任何非候选来源——任务结果、明确约定、新素材、普通补充——
 * 桥接不判断该不该发,只负责把已经固定好的分段按索引送到合法绑定并逐段
 * 回报。候选策略、画像和素材库属于消费方(RIN / 记忆插件),这里不复制一份。
 */
export interface QqDeliveryRequest {
    /** 已合法绑定的 QQ 会话键。 */
    sessionKey: string;
    /** 该会话当前的 DSH 会话 id;缺省时用本进程内已绑定的会话。 */
    sessionId?: string;
    /** 稳定输出标识:同一 outputId + 同一分段索引重试不会产生第二条平台消息。 */
    outputId: string;
    /** 分段正文与固定索引(通常来自核心 /v1/outputs 的 part 索引)。 */
    parts: readonly QqDeliveryPart[];
    /** 来源标签,只用于诊断与日志;投递语义与它无关。 */
    source?: string;
}
/** 一次通用投递的结果:逐段回执 + 仍需续投的索引。 */
export interface QqDeliveryOutcome {
    /** completed 全部段被平台接受;failed 有段未送达可续;cancelled 复查拒绝;unavailable 未尝试。 */
    status: 'completed' | 'failed' | 'cancelled' | 'unavailable';
    parts: Array<{
        index: number;
        ok: boolean;
        platformId?: string;
        error?: string;
    }>;
    /** 仍未送达的分段索引(升序):用同一 outputId 续投这些索引即可。 */
    pending: number[];
    /** 没有尝试投递时的原因(没有合法绑定、传输未注册、会话已换等)。 */
    error?: string;
}
/** 服务在 Cordis 中的名字;订阅方按这个名字注入。 */
export declare const QQ_BRIDGE_EVENTS_SERVICE = "qqBridgeEvents";
export type QqTurnListener = (report: QqTurnReport) => void;
export interface QqOutputDelivery {
    parts: Array<{
        index: number;
        ok: boolean;
        platformId?: string;
        error?: string;
    }>;
    status: 'completed' | 'failed' | 'cancelled';
}
type OutputSender = (sessionId: string, outputId: string, parts: Array<{
    index: number;
    text: string;
}>, canSend: () => Promise<boolean>) => Promise<QqOutputDelivery>;
/** 恢复绑定的结果:成功数量与逐条拒绝原因(拒绝不抛错,调用方一次看完)。 */
export interface QqBindingRestoreReport {
    restored: number;
    /** 已在本进程由真实入站确认的绑定,保持不动。 */
    kept: number;
    rejected: Array<{
        sessionKey: string;
        reason: string;
    }>;
}
/**
 * 一次订阅的句柄。`dispose` 幂等:重复调用、或在服务已卸载后调用都安全。
 */
export interface QqTurnSubscription {
    dispose(): void;
}
/**
 * 只读事件出口。
 *
 * `subscribe` 同步注册:注册完成后再发生的一轮一定会通知到;注册之前已经结束
 * 的轮次不会补发(补交由订阅方自己的持久队列负责,不靠桥接重放)。
 */
export declare class QqBridgeEvents {
    private readonly listeners;
    private readonly admissions;
    private readonly bindings;
    /** 重启后恢复的合法拥有者身份;键是桥接自己生成的 sessionKey。 */
    private readonly restored;
    /** sessionKey → 本进程的 DSH 会话 id。DSH 会话 id 每次启动都会变。 */
    private readonly sessions;
    /** 身份复核钩子:由桥接在 AccessGate 就绪后注册,恢复时不信任存档里的 owner 声明。 */
    private identityVerifier?;
    /** 会话建立钩子:恢复绑定后由桥接自己的执行器建本进程会话。 */
    private sessionBinder?;
    private retirer?;
    private pusher?;
    platform: 'official' | 'napcat';
    private replay?;
    private outputSender?;
    private maxMessageLength;
    private activeOutputs;
    beginOutput(sessionId: string): () => void;
    waitForOutput(sessionId: string): Promise<void>;
    setOutputLimit(maximum: number): void;
    setOutputSender(sender: OutputSender): () => void;
    normalizeOutput(text: string): string;
    planOutput(text: string): {
        text: string;
        part_sizes: number[];
    };
    assistantText(events: readonly unknown[]): string;
    deliverOutput(sessionId: string, outputId: string, parts: Array<{
        index: number;
        text: string;
    }>, canSend: () => Promise<boolean>): Promise<QqOutputDelivery> | undefined;
    setReplay(replay: () => QqTurnReport[]): () => void;
    binding(sessionId: string): QqTurnInput | undefined;
    /**
     * 会话键的唯一生成规则。订阅方不要在别处重算:字符串一旦不同,恢复出来的
     * 绑定就会指向另一个人,而不是同一个主人。
     */
    sessionKeyOf(scope: 'private' | 'group', userId: string | number, groupId?: string | number): string;
    /**
     * 由桥接注册身份复核(通常包住 AccessGate.isOwner)。
     *
     * 存档里的 owner 只是当时的结论;重启后必须用当前配置重新确认,否则改过的
     * 白名单会让旧文件继续冒充主人。没有注册复核时恢复一律拒绝。
     */
    setIdentityVerifier(verifier: (record: QqBindingRecord) => boolean): () => void;
    /**
     * 重启后恢复已有合法绑定,不需要主人再发一条消息。
     *
     * 只接受能自证的事实:会话键必须等于本类生成的规则,scope 与平台 id 必须
     * 对得上,owner 恒为 true,并且当前配置仍认这个身份。四项任一不成立就进
     * rejected,调用方据此删掉自己的旧记录——绝不按昵称、群名片或会话前缀去猜。
     *
     * 已由真实入站确认的绑定不会被覆盖(kept),恢复只补空的那些。
     */
    restoreBindings(records: readonly QqBindingRecord[]): QqBindingRestoreReport;
    /** 已恢复但本进程还没有 DSH 会话的绑定。 */
    restoredBindings(): QqBindingRecord[];
    /**
     * 把本进程新建的 DSH 会话挂到已恢复的绑定上。
     *
     * DSH 会话 id 每次启动都会变,存档里那个已经失效;恢复的是身份,会话由
     * 桥接在本进程重新创建后回填。挂上之后 deliverByIndex 就能不经新入站投递。
     */
    bindSession(sessionKey: string, sessionId: string): boolean;
    /**
     * 由桥接注册"为这个会话键建一个本进程的 DSH 会话"(通常接 executor.prepareSession)。
     *
     * 恢复的是身份,不是会话:DSH 会话 id 每次启动都会变,所以重启后必须由桥接
     * 自己的执行器重新建一次,恢复出来的绑定才真的能投递。注册者不出现时
     * ensureSessions 会明确失败,而不是假装已经可投。
     */
    setSessionBinder(binder: (record: QqBindingRecord) => Promise<string | undefined>): () => void;
    /**
     * 为已恢复但还没有会话的绑定建立本进程会话,不需要主人再发一条消息。
     *
     * 逐条独立:某一条建不起来只让它自己进 failed,不影响其它绑定;调用方按
     * failed 决定是重试还是等真实入站。
     */
    ensureSessions(): Promise<{
        bound: number;
        failed: Array<{
            sessionKey: string;
            reason: string;
        }>;
    }>;
    /** 导出可持久化的身份记录(不含任何输入文本或凭据)。 */
    bindingRecords(): QqBindingRecord[];
    /**
     * 通用投递(RO04-B):按固定 output/part 索引把正文送到合法绑定。
     *
     * 与候选无关:正文来自哪里、为什么现在说,都不在这里判断。这里只做三件
     * 桥接才有资格做的事——确认绑定仍是当前合法主人、复用同一份 delivery-store
     * 让已送达段不重发、把平台回执按原索引报回去。部分失败返回 pending 索引,
     * 调用方用同一个 outputId 再投一次只会发送未送达的段。
     */
    deliverByIndex(request: QqDeliveryRequest, canSend?: () => Promise<boolean>): Promise<QqDeliveryOutcome>;
    subscribeAdmission(listener: (input: QqTurnInput) => Promise<void>): QqTurnSubscription;
    prepare(input: QqTurnInput): Promise<void>;
    /**
     * 由宿主插件注册"主动给管理员发一条文字"的能力。
     *
     * 桥接自己知道该发给谁(管理员 QQ / OpenID)和怎么发,别的插件不该复制
     * 这份配置。注册者不出现时 pushPrivate 返回 undefined,调用方据此降级,
     * 而不是假装送达。
     */
    setPusher(pusher: (text: string) => Promise<void>): () => void;
    /** 向管理员推送一条文字。没注册推送者时返回 undefined。 */
    pushPrivate(text: string): Promise<void> | undefined;
    setRetirer(retirer: (sessionId: string) => Promise<void>): () => void;
    retireSession(sessionId: string): Promise<void>;
    subscribe(listener: QqTurnListener): QqTurnSubscription;
    /**
     * 发布一轮的结果。监听器抛错只影响它自己:桥接的收发不能因为某个订阅方
     * 出错而失败。
     */
    publish(report: QqTurnReport): void;
    /** 卸载时清空订阅,避免已销毁的服务继续持有回调。 */
    dispose(): void;
    get listenerCount(): number;
}
export {};
