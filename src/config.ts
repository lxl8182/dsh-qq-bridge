import { z } from 'zod'
import { DEFAULT_QQ_REPLY_STYLE_SKILL_NAME } from './handlers/agent.js'

const DshQqBridgeConfig = z.object({
  /** Bundle 默认保持 inert；setup 或 Web 设置保存后显式启用。 */
  enabled: z.boolean().default(false),
  platform: z.enum(['napcat', 'official']).default('napcat'),
  napcat: z.object({
    /** NapCat 登录端 QQ；双号模式下与发送端 QQ 不同，仅用于 Web 设置页检测本机 NapCat。 */
    loginQq: z.number().int().nonnegative().default(0),
    autoRestart: z.boolean().default(true),
    wsUrl: z.string().url().default('ws://127.0.0.1:3001'),
    token: z.string().optional(),
    /** 连接失败时提示用户查看的安装向导文档路径(给 Agent 的指引)。 */
    guideDoc: z.string().optional().default('docs/agent-napcat-guide.md'),
  }).default({}),
  official: z
    .object({
      /** 腾讯 QQ 机器人开放平台 AppID。 */
      appId: z.string().default(''),
      /** 腾讯 QQ 机器人开放平台 AppSecret。 */
      appSecret: z.string().default(''),
      /** 管理员在该机器人下的 openid;用户需先给机器人发消息才能获得。 */
      adminOpenId: z.string().default(''),
      /** 官方机器人模式下额外允许的用户 openid。 */
      allowlistOpenIds: z.array(z.string()).default([]),
      /** 是否使用官方沙箱 API。 */
      sandbox: z.boolean().default(false),
    })
    .default({}),
  access: z
    .object({
      adminQq: z.number(),
      allowlist: z.array(z.number()).default([]),
      commandPrefix: z.string().default(''),
      mode: z.enum(['whitelist', 'open']).default('whitelist'),
    })
    .default({ adminQq: 0 }),
  agent: z
    .object({
      /** DSH Web 的 agent preset;存在 agentPresets 服务时默认挂 QQ bridge 专用 preset。 */
      preset: z.string().optional().default('dsh-qq-bridge'),
      /** 驱动 agent 的 provider 路由(须有已注册适配器)。 */
      provider: z.string().default('deepseek-official'),
      /** 驱动 agent 的模型 id(provider 适配器解释)。 */
      model: z.string().default('deepseek-v4-flash'),
      /**
       * 默认思考强度(provider 适配器的 effort id,如 low/medium/high/max)。
       *
       * 不同 provider 对"不传"的处理不一样:官方 deepseek 适配器自带默认值,而
       * 裸的 openai-completions provider 不传就完全不思考——同一个模型在 QQ 里
       * 会看起来"变笨了"。这里给一个显式默认,新会话与重启后都保持同一强度。
       * 留空则沿用适配器自己的行为,QQ 会话里仍可用 /reasoningEff 临时切换。
       */
      reasoningEffort: z.string().optional(),
      /** 当 DSH llm 服务不可用时,bridge 侧 /models 的降级候选列表。 */
      models: z.array(z.string()).default([]),
      /** QQ Agent 默认工作目录;支持 ~ 表示当前用户 home。 */
      cwd: z.string().default('~'),
      /** 单条 QQ 消息最大长度(字符数);超长自动拆分为多条发送。QQ 官方单条约 5000 字,默认留余量。 */
      maxMessageLength: z.number().int().positive().default(4500),
      /** 收到有效 QQ 指令后立即回发的确认消息;设为空字符串可关闭。 */
      ackMessage: z.string().default('收到，正在处理...'),
      /** Agent 本轮最长等待时间(ms);未设置时不限制 QQ 对话等待时间。 */
      timeoutMs: z.number().int().positive().optional(),
      /** Agent 长时间无响应时回发的消息;仅设置 timeoutMs 后使用。 */
      timeoutMessage: z.string().default('agent 无响应，请稍后重试。'),
      /**
       * 旧版「QQ 回复风格 skill」配置。
       *
       * 仅为配置兼容保留:桥接层不再拼装来源说明/风格标记,也不再自动调用 skill,
       * QQ 入站消息原文会逐字交给 Agent。该项当前的取值不影响发出的 payload。
       */
      qqReplyStyleSkill: z
        .object({
          enabled: z.boolean().default(true),
          skillName: z.string().default(DEFAULT_QQ_REPLY_STYLE_SKILL_NAME),
        })
        .default({}),
    })
    .default({}),
  shell: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({}),
  notifications: z
    .object({
      agentReply: z
        .object({
          /** Agent 完成后是否主动向管理员发送提醒。不设置时 NapCat 默认开,官方机器人默认关。 */
          enabled: z.boolean().optional(),
        })
        .default({}),
    })
    .default({}),
  selfLogInput: z
    .object({
      /** 实验性:tail NapCat 日志中的 self-sent 消息,用于自己给自己发消息的单号场景。 */
      enabled: z.boolean().default(false),
      /** NapCat 日志路径;缺省按 ~/Napcat/log/napcat_<adminQq>.log 推导。 */
      logPath: z.string().optional(),
      /** 轮询间隔(ms)。 */
      pollIntervalMs: z.number().int().positive().default(1000),
      /** 启动时是否回放已有日志;默认只处理启动后的新行,避免误触发历史消息。 */
      replayOnStart: z.boolean().default(false),
    })
    .default({}),
})

export type DshQqBridgeConfig = z.infer<typeof DshQqBridgeConfig>
export { DshQqBridgeConfig }
