import { MessageTargetId, OnebotMessageEvent, OnebotMessageType } from './onebot/types.js'

export interface AccessOptions {
  /** 拥有者 QQ(NapCat 模式兼容字段)。 */
  adminQq?: number
  /** 拥有者平台身份:官方机器人模式为 adminOpenId,NapCat 模式可省略并回退 adminQq。 */
  adminId?: MessageTargetId
  /** 额外允许的 user_id/openid */
  allowlist: MessageTargetId[]
  /** 指令前缀。空字符串表示白名单用户的所有消息都进入 router。 */
  commandPrefix: string
  /** whitelist: 只允许 admin+allowlist;open: 任何人都能触发(仅测试用) */
  mode: 'whitelist' | 'open'
}

/**
 * 安全门:白名单 + 指令前缀过滤。
 */
export class AccessGate {
  constructor(private readonly opts: AccessOptions) {}

  /**
   * 是否允许这条消息进入 router。
   * whitelist 模式仅放行 admin + allowlist;open 模式放行任何人。
   * 群聊默认也受白名单约束(避免陌生人在群里触发)。
   */
  allow(evt: Pick<OnebotMessageEvent, 'user_id'>): boolean {
    if (this.opts.mode === 'open') return true
    const adminId = this.opts.adminId ?? this.opts.adminQq
    return evt.user_id === adminId || this.opts.allowlist.includes(evt.user_id)
  }

  /**
   * 这条消息是否来自已校验的拥有者。
   *
   * 与 `allow` 分开:open 模式、白名单成员和拥有者过去都“能触发”,但只有拥有者
   * 才代表同一个人格与同一份个人记忆。昵称、群号或 `qq-` 前缀都不能替代这个判断,
   * 唯一依据是 bridge 配置里的 admin 身份。
   */
  isOwner(evt: Pick<OnebotMessageEvent, 'user_id'>): boolean {
    const adminId = this.opts.adminId ?? this.opts.adminQq
    return adminId !== undefined && adminId !== 0 && evt.user_id === adminId
  }

  /**
   * 剥离指令前缀,返回剩余有效载荷;若不以前缀开头返回 null。
   * commandPrefix 为空时返回整条消息,由白名单决定是否放行。
   */
  stripPrefix(text: string): string | null {
    const trimmed = text.trim()
    if (this.opts.commandPrefix === '') return trimmed
    if (!trimmed.startsWith(this.opts.commandPrefix)) return null
    return trimmed.slice(this.opts.commandPrefix.length).trim()
  }
}

export type { OnebotMessageType }
