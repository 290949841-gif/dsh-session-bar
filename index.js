export const name = "dsh-done-flash"

// Host half 故意留空：这个插件只在浏览器侧动 DOM，
// 不需要 agent 事件、不需要 server 端服务，也不再往 fiber 图里塞任何东西。
export function apply() {}
