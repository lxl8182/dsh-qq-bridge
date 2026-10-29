/**
 * OneBot v11 协议常用类型(仅定义我们用到的子集)。
 */

/** onebot 推送上来的消息事件(私聊/群聊的公共形状) */
export type OnebotMessageType = 'private' | 'group'

/** 当前桥接层使用的会话/用户目标标识。NapCat 是 QQ 号,官方机器人是 openid。 */
export type MessageTargetId = number | string

/** 平台原生回复目标。官方机器人用它把回复关联到当前入站消息。 */
export interface PlatformReplyTarget {
  platform: 'official'
  scope: 'c2c' | 'group'
  targetId: string
  msgId?: string
}

/** OneBot v11 消息段;本项目只消费 `image`,其余段保持原样不解释。 */
export interface OnebotMessageSegment {
  type: string
  data?: Record<string, unknown>
}

export interface OnebotMessageEvent {
  /** 事件类型,如 'message' */
  post_type: string
  /** 'private' | 'group' */
  message_type: OnebotMessageType
  /** 发送者标识:NapCat 为 QQ 号,官方机器人为 openid。 */
  user_id: MessageTargetId
  /** 接收入站消息的机器人账号。 */
  self_id?: MessageTargetId
  sender?: { nickname?: string; card?: string }
  /** 群聊才有 */
  group_id?: MessageTargetId
  /** 文本视图:图片在这里是空的,图片内容只能从 `message` 段取。 */
  raw_message: string
  /**
   * 平台原生消息段(OneBot v11),或由官方机器人附件归一化出的图片段。
   *
   * 缺省表示平台没有提供段数组(例如只回放 NapCat 日志的单号场景)。
   */
  message?: readonly OnebotMessageSegment[]
  /** 消息 id(可用于防重复处理) */
  message_id: MessageTargetId
  /** 私聊时 sub_type: 'friend' | 'group' | 'other' */
  sub_type?: string
  /** 平台原生回复目标;NapCat 模式为空。 */
  reply_target?: PlatformReplyTarget
}

/** 发送动作的响应 */
export interface OnebotActionResponse<T = unknown> {
  status: 'ok' | 'failed'
  retcode: number
  data: T
}

/** WS 收到的通用包裹(事件 or 后端动作响应) */
export type IncomingFrame =
  | { echo?: string }
  | { post_type: string }
