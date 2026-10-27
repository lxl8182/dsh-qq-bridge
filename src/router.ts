import { MessageTargetId, OnebotMessageEvent, PlatformReplyTarget } from './onebot/types.js'
import { AccessGate } from './security.js'
import { imageSourcesFromOnebotSegments, type ImageSource } from './onebot/images.js'

/**
 * handler 上下文:暴露来源信息与便捷回发能力。
 */
export interface HandlerContext {
  userId: MessageTargetId
  scope: 'private' | 'group'
  groupId?: MessageTargetId
  /** 已经剥离指令前缀后的有效载荷 */
  payload: string
  /**
   * 这条消息是否来自已校验的拥有者(不是白名单成员,不是陌生人)。
   * 人格与个人记忆只跟随这个身份,昵称/群号/会话前缀都不作数。
   */
  owner: boolean
  /** 平台消息 id;用于把一次入站与它引起的生成关联起来。 */
  messageId?: MessageTargetId
  replyTarget?: PlatformReplyTarget
  /**
   * 本条消息里图片的地址,按出现顺序。
   *
   * 这里只有地址,没有字节:命令类 handler 不该为了响应一条 "/help" 去下载图片。
   * 需要图片的处理器(Agent 轮次)自己调用 `collectInboundImages` 下载,失败只损失
   * 图片,不影响文本处理。
   */
  images?: readonly ImageSource[]
  /** 回发到来源会话 */
  respond(text: string): Promise<void>
  /**
   * 回发并返回平台接收结果。
   *
   * `respond` 只报告“没有抛错”,调用方无法区分已送达与静默失败;需要记录平台
   * 接收事实时用这个形态。返回 `undefined` 表示平台未提供消息 id。
   */
  send?(text: string): Promise<{ platformId?: string }>
}

export interface Handler {
  name: string
  /** 是否愿意处理这条 message(如按 payload 命令名匹配) */
  test(payload: string): boolean
  /** 命中后是否继续尝试后续 handler。默认 false,命令 handler 会独占消费。 */
  continueAfterRun?: boolean
  run(ctx: HandlerContext): Promise<void>
}

export interface PendingReplyHandler {
  handle(ctx: HandlerContext): Promise<boolean>
}

export type OutboundSender = (
  scope: 'private' | 'group',
  targetId: MessageTargetId,
  text: string,
  replyTarget?: PlatformReplyTarget,
) => Promise<void>

/** 带平台回执的出站发送;返回值里的 id 来自平台动作响应。 */
export type OutboundSendReceipt = ((
  scope: 'private' | 'group',
  targetId: MessageTargetId,
  text: string,
  replyTarget?: PlatformReplyTarget,
) => Promise<{ platformId?: string } | void>) | undefined

/**
 * C 骨架:消息分发器。注册 handler,按前缀 + 匹配路由。
 */
export class MessageRouter {
  private handlers = new Map<string, Handler>()

  constructor(
    private readonly gate: AccessGate,
    private readonly outbound: OutboundSender,
    private readonly pendingReply?: PendingReplyHandler,
    /**
     * 带平台回执的发送器。缺省时 `ctx.send` 退化为 `respond` 且不带 id:
     * 旧调用方与旧传输层不需要改动,新调用方拿不到 id 时也知道自己拿不到。
     */
    private readonly outboundWithReceipt?: OutboundSendReceipt,
  ) {}

  register(handler: Handler): () => void {
    this.handlers.set(handler.name, handler)
    return () => this.handlers.delete(handler.name)
  }

  /**
   * 处理一条入站消息:
   * 1. 白名单过滤
   * 2. 前缀剥离
   * 3. 按注册顺序匹配 handler。
   * 返回是否被消费(被 router 处理且至少一个 handler 匹配)。
   */
  async route(evt: OnebotMessageEvent): Promise<boolean> {
    if (!this.gate.allow(evt)) return false

    const scope: 'private' | 'group' = evt.message_type === 'private' ? 'private' : 'group'
    const payload = this.gate.stripPrefix(evt.raw_message)
    if (payload === null) return false

    const targetId = scope === 'private' ? evt.user_id : evt.group_id!
    const respond = async (text: string): Promise<void> => {
      try {
        await this.outbound(scope, targetId, text, evt.reply_target)
      } catch (err) {
        console.warn(
          `[dsh-qq-bridge] failed to send ${scope} message to ${targetId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }

    // 图片只登记地址,不在这里下载:命令 handler 与白名单失败都不该触发网络请求。
    const imageSources = imageSourcesFromOnebotSegments(evt.message)
    const ctx: HandlerContext = {
      userId: evt.user_id,
      scope,
      groupId: evt.group_id,
      payload,
      owner: this.gate.isOwner(evt),
      messageId: evt.message_id,
      replyTarget: evt.reply_target,
      ...(imageSources.length === 0 ? {} : { images: imageSources }),
      respond,
      send: this.outboundWithReceipt
        ? async (text: string) => {
            try {
              const receipt = await this.outboundWithReceipt!(scope, targetId, text, evt.reply_target)
              return receipt && typeof receipt === 'object' ? receipt : {}
            } catch (err) {
              // A failed send is a fact the caller must see; it is not the
              // same as "sent without an id".
              console.warn(
                `[dsh-qq-bridge] failed to send ${scope} message to ${targetId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              )
              throw err
            }
          }
        : async (text: string) => {
            await respond(text)
            return {}
          },
    }

    if (await this.pendingReply?.handle(ctx)) return true

    let consumed = false
    for (const handler of this.handlers.values()) {
      if (handler.test(payload)) {
        consumed = true
        await handler.run(ctx)
        if (!handler.continueAfterRun) return true
      }
    }
    return consumed
  }
}
