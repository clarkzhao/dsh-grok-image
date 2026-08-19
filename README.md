# dsh-grok-image

DeepSeek Harness 插件:把 **Grok Imagine 图片生成**(订阅额度)注册成 DSH 的模型工具 `image_gen`。

- GitHub: https://github.com/clarkzhao/dsh-grok-image (待发布)
- topic: `dsh-plugin`

## 能力

- 工具 `image_gen`:根据文本描述生成图片
- 走 Grok 订阅端点 `https://cli-chat-proxy.grok.com/v1/images/generations`,与 `dsh-llm-grok` 同一凭据(`GROK_SESSION_TOKEN`)与代理(Clash `http://127.0.0.1:7890`)
- 模型:`grok-imagine-image-quality`(默认,可配置)
- 比例:auto / 1:1 / 16:9 / 9:16 / 3:2 / 2:3
- 参数 `inline_image`(默认 true):是否把图片内联进对话。**当前模型适配器不支持图片内容时**(如 deepseek),设 `false` 只返回保存路径
- 生成结果:
  - 写入 DSH 附件服务 → Web UI 直接内联渲染,模型可继续看图(grok 模型)
  - 同时落盘到 `outputDir`(默认 `~/grok-images`)→ 本地文件副本
  - 用量记入 `usage.log.jsonl`(成本核算用;Imagine API 不返回单次 usage)

## 安装

```bash
dsh plugin --profile web add dsh-grok-image
# 本地开发:
dsh plugin --profile web add ./dsh-grok-image
```

安装后 bundle 写入 `grok-image` 并注册 `image_gen` 工具。需重启 DSH 生效。

## 配置

```yaml
- id: grok-image
  name: dsh-grok-image
  config:
    baseURL: https://cli-chat-proxy.grok.com/v1
    apiKeyEnv: GROK_SESSION_TOKEN
    proxy: http://127.0.0.1:7890
    model: grok-imagine-image-quality
    outputDir: ~/Workspace/grok-images
    usageLog: true
```

## 开发

```bash
pnpm install
npm test
npm run build
```

## 限制

- 只实现 `image_gen`;`image_edit`(图生图)与 `video_gen` 未实现,参考 grok-build 同模式可后续扩展
- 免费 / X Basic 档用户会被订阅端点零额度限制(SuperGrok 专属能力)
- 生成耗时可达 1-2 分钟,工具超时 300s
