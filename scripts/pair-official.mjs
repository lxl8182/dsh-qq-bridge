import { input, password, confirm } from '@inquirer/prompts'
import { randomBytes } from 'node:crypto'
import { pairOfficialAdmin } from '../dist/cli/official-pairing.js'

let secret = ''
try {
  const appId = (await input({ message: 'QQ 机器人 AppID：', required: true })).trim()
  secret = await password({ message: 'QQ 机器人 AppSecret：', mask: '*' })
  const sandbox = await confirm({ message: '使用沙箱环境？', default: false })
  const pairCommand = `pair ${randomBytes(4).toString('hex').toUpperCase()}`
  const openId = await pairOfficialAdmin({
    appId, appSecret: secret, sandbox, pairCommand, timeoutMs: 180000,
    onReady() {
      console.log(`\n请用你的主人 QQ 私聊这个机器人，发送：\n\n${pairCommand}\n`)
    },
  })
  console.log(`\nAdmin OpenID：${openId}`)
  console.log('将它填入 DSH 的 QQ bridge 设置。只有自己使用时，Allowlist OpenIDs 留空。')
} catch (error) {
  const message = error?.name === 'ExitPromptError' ? '配对已取消。' : String(error?.message ?? error)
  console.error(secret ? message.split(secret).join('[redacted]') : message)
  process.exitCode = 1
}
