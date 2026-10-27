import { HandlerContext } from '../router.js';
import { DirectorySwitcher } from './directory.js';
import type { ModelSelectionController, PermissionController, SessionLifecycleController } from './model-control.js';
export declare const QQ_CONTROL_BLOCK_TAG = "dsh-qq-bridge-control";
/**
 * 「魔法」咒语标签。
 *
 * 主会话不上报任何工具（见 dsh-companion-memory 的 main-session.js 实测说明）：
 * 只要请求里存在 tools 字段，模型的 thinking 就会被拉进 function-calling 规划
 * 模式，角色独白变成第三人称分析。动作因此改由正文标签表达——纯文本，不触发
 * 函数调用语境。执行与回填归 companion-memory 插件；这里只剥离 QQ 可见文字。
 */
export declare const QQ_SPELL_TAGS: readonly ["读取", "生成", "执行", "翻本子", "改写", "撕掉", "学咒语", "忘掉咒语"];
export type QqSpellName = string;
export interface QqSpell {
    spell: QqSpellName;
    body: string;
}
export interface ParsedQqSpells {
    /** 去掉咒语后的可见正文（可能为空串）。 */
    visibleText: string;
    spells: QqSpell[];
}
/**
 * 从回复里拆出可见正文与咒语。
 *
 * 未闭合的标签不当作咒语执行：那多半是模型写了一半就停了，如实留在正文里让
 * 用户看见"它想做什么但没说完"，而不是猜一个意思去跑。
 */
export declare function parseQqSpells(text: string): ParsedQqSpells;
/** 一条咒语执行结束后回填给模型的「终端反馈」。 */
export declare function renderQqSpellFeedback(spell: QqSpell, ok: boolean, text: string): string;
export interface QqSpellHandler {
    spell: QqSpellName;
    run(body: string, ctx: QqControlContext): Promise<string>;
}
/** 与 QQ 控制块同一套分发形态：注册者决定某个咒语真的怎么执行。 */
export declare class QqSpellDispatcher {
    private readonly handlers;
    register(handler: QqSpellHandler): () => void;
    get size(): number;
    run(spell: QqSpell, ctx: QqControlContext): Promise<{
        ok: boolean;
        text: string;
    }>;
}
export interface QqControlAction {
    action: string;
    [key: string]: unknown;
}
export interface ParsedQqControls {
    visibleText: string;
    actions: QqControlAction[];
    errors: string[];
}
export interface QqControlContext {
    sessionKey: string;
    source: HandlerContext;
}
export interface QqControlActionHandler {
    action: string;
    run(action: QqControlAction, ctx: QqControlContext): Promise<string | undefined>;
}
export declare class QqControlDispatcher {
    private readonly handlers;
    register(handler: QqControlActionHandler): () => void;
    dispatch(action: QqControlAction, ctx: QqControlContext): Promise<string | undefined>;
}
export declare function parseQqControlBlocks(text: string): ParsedQqControls;
export declare function createSetCwdControlHandler(switcher: DirectorySwitcher): QqControlActionHandler;
export declare function createSetModelControlHandler(controller: ModelSelectionController): QqControlActionHandler;
export declare function createSetReasoningEffortControlHandler(controller: ModelSelectionController): QqControlActionHandler;
export declare function createSetPermissionControlHandler(controller: PermissionController): QqControlActionHandler;
export declare function createNewSessionControlHandler(controller: SessionLifecycleController): QqControlActionHandler;
