import { stat } from 'node:fs/promises';
import { resolveUserPath } from './directory.js';
export const QQ_CONTROL_BLOCK_TAG = 'dsh-qq-bridge-control';
/**
 * 「魔法」咒语标签。
 *
 * 主会话不上报任何工具（见 dsh-companion-memory 的 main-session.js 实测说明）：
 * 只要请求里存在 tools 字段，模型的 thinking 就会被拉进 function-calling 规划
 * 模式，角色独白变成第三人称分析。动作因此改由正文标签表达——纯文本，不触发
 * 函数调用语境。执行与回填归 companion-memory 插件；这里只剥离 QQ 可见文字。
 */
export const QQ_SPELL_TAGS = ['读取', '生成', '执行', '翻本子', '改写', '撕掉', '学咒语', '忘掉咒语'];
/**
 * 从回复里拆出可见正文与咒语。
 *
 * 未闭合的标签不当作咒语执行：那多半是模型写了一半就停了，如实留在正文里让
 * 用户看见"它想做什么但没说完"，而不是猜一个意思去跑。
 */
export function parseQqSpells(text) {
    const source = String(text ?? '');
    const spells = [];
    if (!source)
        return { visibleText: '', spells };
    // 学来的咒语也使用 2–8 个中文字符的名字；剥离不依赖执行插件的模板台账。
    const pattern = /<([\p{Script=Han}]{2,8})>([\s\S]*?)<\/\1>/gu;
    let last = 0;
    let visible = '';
    let match;
    while ((match = pattern.exec(source)) !== null) {
        visible += source.slice(last, match.index);
        const body = match[2].trim();
        if (body)
            spells.push({ spell: match[1], body });
        last = match.index + match[0].length;
    }
    visible += source.slice(last);
    return { visibleText: visible.replace(/\n{3,}/g, '\n\n').trim(), spells };
}
/** 一条咒语执行结束后回填给模型的「终端反馈」。 */
export function renderQqSpellFeedback(spell, ok, text) {
    const body = String(text ?? '').trim();
    if (!ok)
        return `【终端反馈·${spell.spell}】失败：${body || '未知原因'}`;
    return body ? `【终端反馈·${spell.spell}】\n${body}` : `【终端反馈·${spell.spell}】\n（没有输出）`;
}
/** 与 QQ 控制块同一套分发形态：注册者决定某个咒语真的怎么执行。 */
export class QqSpellDispatcher {
    handlers = new Map();
    register(handler) {
        this.handlers.set(handler.spell, handler);
        return () => this.handlers.delete(handler.spell);
    }
    get size() {
        return this.handlers.size;
    }
    async run(spell, ctx) {
        const handler = this.handlers.get(spell.spell);
        if (!handler)
            return { ok: false, text: '这个咒语现在还没有接上。' };
        try {
            return { ok: true, text: await handler.run(spell.body, ctx) };
        }
        catch (err) {
            return { ok: false, text: err instanceof Error ? err.message : String(err) };
        }
    }
}
export class QqControlDispatcher {
    handlers = new Map();
    register(handler) {
        this.handlers.set(handler.action, handler);
        return () => this.handlers.delete(handler.action);
    }
    async dispatch(action, ctx) {
        const handler = this.handlers.get(action.action);
        if (!handler)
            return `不支持的 QQ 控制动作: ${action.action}`;
        return await handler.run(action, ctx);
    }
}
export function parseQqControlBlocks(text) {
    const errors = [];
    const actions = [];
    const pattern = new RegExp(`<${QQ_CONTROL_BLOCK_TAG}>\\s*([\\s\\S]*?)\\s*<\\/${QQ_CONTROL_BLOCK_TAG}>`, 'g');
    const visibleText = text.replace(pattern, (_block, rawJson) => {
        try {
            const parsed = JSON.parse(rawJson);
            if (!isQqControlAction(parsed)) {
                errors.push('QQ 控制块格式无效: 需要包含字符串 action 字段。');
            }
            else {
                actions.push(parsed);
            }
        }
        catch (err) {
            errors.push(`QQ 控制块 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
        }
        return '';
    }).trim();
    return { visibleText, actions, errors };
}
export function createSetCwdControlHandler(switcher) {
    return {
        action: 'set_cwd',
        async run(action, ctx) {
            if (typeof action.path !== 'string' || action.path.trim() === '') {
                return 'QQ 控制块 set_cwd 缺少 path。';
            }
            const baseCwd = switcher.getCwd?.(ctx.sessionKey);
            const cwd = resolveUserPath(action.path.trim(), baseCwd);
            const info = await stat(cwd).catch(() => null);
            if (!info?.isDirectory()) {
                return `目录不存在或不是目录: ${cwd}`;
            }
            await switcher.setCwd(ctx.sessionKey, cwd);
            return `已切换当前 QQ 会话工作区: ${cwd}\n下一条消息会使用新的 Agent session。`;
        },
    };
}
export function createSetModelControlHandler(controller) {
    return {
        action: 'set_model',
        async run(action, ctx) {
            if (typeof action.model !== 'string' || action.model.trim() === '') {
                return 'QQ 控制块 set_model 缺少 model。';
            }
            const model = action.model.trim();
            const available = await controller.listModels(ctx.sessionKey);
            const matches = available.filter(entry => entry.id === model);
            if (matches.length === 0) {
                return `未找到模型: ${model}\n${formatModelIds(available)}`;
            }
            if (new Set(matches.map(entry => entry.provider)).size > 1) {
                return `模型名 ${model} 在多个 provider 中重复；当前 QQ 控制动作只接受唯一模型名。`;
            }
            const selected = await controller.selectModel(ctx.sessionKey, model);
            return formatSelection('已切换模型', selected);
        },
    };
}
export function createSetReasoningEffortControlHandler(controller) {
    return {
        action: 'set_reasoning_effort',
        async run(action, ctx) {
            if (typeof action.reasoningEffort !== 'string' || action.reasoningEffort.trim() === '') {
                return 'QQ 控制块 set_reasoning_effort 缺少 reasoningEffort。';
            }
            const effort = action.reasoningEffort.trim();
            const current = controller.getModelSelection(ctx.sessionKey);
            const info = (await controller.listModels(ctx.sessionKey)).find(entry => entry.provider === current.provider && entry.id === current.model);
            const choices = info?.reasoningEfforts?.length
                ? info.reasoningEfforts
                : ['off', 'low', 'medium', 'high', 'max'];
            if (!choices.includes(effort)) {
                return `未找到推理等级: ${effort}\n可选: ${choices.join(', ')}`;
            }
            const selected = await controller.selectReasoningEffort(ctx.sessionKey, effort);
            return formatSelection('已切换推理等级', selected);
        },
    };
}
export function createSetPermissionControlHandler(controller) {
    return {
        action: 'set_permission',
        async run(action, ctx) {
            if (typeof action.preset !== 'string' || action.preset.trim() === '') {
                return 'QQ 控制块 set_permission 缺少 preset。';
            }
            return await controller.runPermissionCommand(ctx.sessionKey, action.preset.trim());
        },
    };
}
export function createNewSessionControlHandler(controller) {
    return {
        action: 'new_session',
        async run(_action, ctx) {
            await controller.startNewSession(ctx.sessionKey);
            return '已为当前 QQ 聊天新开 Agent session。下一条消息会使用新的上下文。';
        },
    };
}
function isQqControlAction(value) {
    return typeof value === 'object'
        && value !== null
        && typeof value.action === 'string'
        && value.action.trim() !== '';
}
function formatSelection(prefix, selected) {
    return [
        `${prefix}: ${selected.model}`,
        `provider: ${selected.provider}`,
        `reasoningEffort: ${selected.reasoningEffort ?? '(provider default)'}`,
        '下一次模型请求生效；正在运行的请求不受影响。',
    ].join('\n');
}
function formatModelIds(models) {
    if (models.length === 0)
        return '可选模型列表为空。';
    return `可选模型: ${models.map(model => model.id).join(', ')}`;
}
