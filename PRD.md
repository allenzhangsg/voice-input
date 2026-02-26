# Voice Input CLI - Product Requirements Document

## 产品概述

**产品名称**: Voice Input CLI  
**目标**: 构建一个轻量级、跨平台的命令行工具，通过全局快捷键实现系统级语音输入功能，作为 Typeless 的开源替代方案。

**核心价值主张**:
- 在任何应用中按快捷键即可进行语音输入（Slack、Email、Terminal 等）
- 自动转录 + LLM 智能格式化，输出专业文本
- 完全本地运行，无需 GUI，资源占用极低
- 成本可控（~$6/月 vs Typeless $30+/月）

## 核心功能需求

### 1. 全局快捷键监听
**功能**: 在系统任何位置监听预定义快捷键组合

**需求**:
- 默认快捷键: `Ctrl+Shift+Space` (可配置)
- 按下快捷键 = 开始录音
- 松开快捷键 = 停止录音并开始处理
- 必须在后台持续运行，不阻塞其他应用
- 跨平台支持: macOS, Linux, Windows

**技术约束**:
- 使用 `node-global-key-listener` 库
- 需要系统权限（macOS 需要 Accessibility 权限）

### 2. 音频录制
**功能**: 在快捷键按下期间录制麦克风音频

**需求**:
- 录音格式: WAV, 16kHz, 单声道（Whisper 最佳格式）
- 最短录音时长: 0.5 秒（避免误触）
- 最长录音时长: 60 秒（可配置）
- 自动保存到临时目录
- 录制完成后自动清理临时文件

**技术约束**:
- 使用 `node-record-lpcm16` 或 `sox` 命令行工具
- 需要麦克风权限

### 3. 语音转录
**功能**: 将录制的音频转换为文字

**需求**:
- 使用 OpenAI Whisper API (`whisper-1` 模型)
- 自动检测语言（优先英文，支持多语言）
- 错误处理: 网络失败、API 限流、无效音频等
- 显示转录进度和结果

**技术约束**:
- 依赖 `openai` SDK (v4.x)
- 需要 `OPENAI_API_KEY` 环境变量
- 成本: ~$0.006/分钟

### 4. 文本格式化
**功能**: 使用 LLM 智能整理转录文本

**需求**:
- 自动识别上下文（聊天 vs 正式邮件）
- 修正语法错误、添加标点符号
- 保持原意，不过度改写
- 输出干净的文本（无解释、无额外内容）

**格式化规则**:
- 如果是简短、口语化 → Slack/聊天风格
- 如果是正式、完整句子 → Email 格式
- 如果包含代码关键词 → 保留技术术语

**技术约束**:
- 使用 OpenAI GPT-4o-mini
- System prompt 定义格式化规则
- Temperature: 0.3（保持一致性）
- Max tokens: 500

### 5. 文本插入
**功能**: 将格式化后的文本自动输入到当前聚焦的文本框

**需求**:
- 跨应用工作（Slack、VSCode、Terminal、浏览器等）
- 不干扰用户当前操作
- 支持特殊字符、换行、Emoji

**实现策略**（按优先级）:
1. **剪贴板方案**（推荐）:
   - 保存当前剪贴板内容
   - 复制格式化文本到剪贴板
   - 模拟 `Cmd+V` / `Ctrl+V`
   - 恢复原剪贴板内容
   
2. **系统模拟输入**（备选）:
   - macOS: AppleScript `keystroke`
   - Linux: `xdotool type`
   - Windows: PowerShell `SendKeys`

**技术约束**:
- macOS 需要 Accessibility 权限
- Windows 可能需要管理员权限

## 用户体验流程

### 主流程
```
1. 用户按下 Ctrl+Shift+Space
   ↓
2. CLI 显示: "🎙️  录音中... (松开停止)"
   ↓
3. 用户说话后松开快捷键
   ↓
4. CLI 显示: "📝 转录中..."
   → 显示转录结果
   ↓
5. CLI 显示: "✨ 格式化中..."
   → 显示格式化结果
   ↓
6. CLI 显示: "⌨️  输入中..."
   ↓
7. 文本自动出现在当前文本框
   ↓
8. CLI 显示: "✓ 完成 (用时 2.3s, 成本 $0.002)"
   ↓
9. 回到监听状态
```

### 错误处理流程
```
录音太短 → 提示 "录音时长不足，请重试"
网络错误 → 提示 "无法连接 OpenAI API，请检查网络"
API 失败 → 提示具体错误信息 + 建议
权限不足 → 引导用户授予必要权限
```

## 技术架构

### 项目结构
```
voice-input-cli/
├── src/
│   ├── index.ts              # CLI 入口，快捷键监听
│   ├── config.ts             # 配置管理 (API keys, 快捷键等)
│   ├── services/
│   │   ├── recorder.ts       # 音频录制服务
│   │   ├── transcription.ts  # Whisper 转录服务
│   │   ├── formatter.ts      # LLM 格式化服务
│   │   └── inserter.ts       # 文本插入服务
│   ├── utils/
│   │   ├── logger.ts         # 美化日志输出 (chalk + ora)
│   │   └── permissions.ts    # 权限检查和引导
│   └── types.ts              # TypeScript 类型定义
├── bin/
│   └── voice-input           # CLI 可执行文件
├── .env.example              # 环境变量模板
├── package.json
├── tsconfig.json
└── README.md
```

### 技术栈

**核心依赖**:
- `node-global-key-listener` - 全局快捷键监听
- `openai` (v4.x) - Whisper + GPT API
- `node-record-lpcm16` - 音频录制
- `clipboardy` - 剪贴板操作
- `robotjs` - 键盘模拟（备选方案）

**开发工具**:
- TypeScript 5.x
- `chalk` - 彩色终端输出
- `ora` - 进度指示器
- `dotenv` - 环境变量管理
- `commander` - CLI 参数解析（可选）

**系统工具**（可选）:
- macOS: `sox`, `osascript`
- Linux: `sox`, `xdotool`
- Windows: PowerShell

### 配置管理

**环境变量** (`.env`):
```
OPENAI_API_KEY=sk-...           # 必需
HOTKEY=ctrl+shift+space         # 可选，默认值
MAX_RECORDING_SECONDS=60        # 可选，默认 60
MIN_RECORDING_SECONDS=0.5       # 可选，默认 0.5
LANGUAGE=en                     # 可选，默认 auto
MODEL=gpt-4o-mini               # 可选，默认 gpt-4o-mini
```

**配置文件** (`~/.voice-input/config.json`) - 可选:
```json
{
  "hotkey": "ctrl+shift+space",
  "language": "en",
  "formatStyle": "auto",
  "insertMethod": "clipboard"
}
```

## 命令行接口

### 主命令
```bash
# 启动后台服务（默认）
voice-input

# 显示帮助
voice-input --help

# 显示版本
voice-input --version

# 测试模式（不实际插入文本）
voice-input --test

# 配置向导
voice-input config

# 检查权限
voice-input check-permissions
```

### 子命令（可选扩展）
```bash
# 单次语音输入（不启动后台服务）
voice-input once

# 查看使用统计
voice-input stats

# 清理缓存和临时文件
voice-input clean
```

## 性能要求

### 响应时间
- 录音启动延迟: < 200ms
- 转录时间: < 3 秒（10 秒音频）
- 格式化时间: < 1 秒
- 文本插入延迟: < 100ms
- **总流程**: 10 秒音频 → 完成输入 < 5 秒

### 资源占用
- 内存占用: < 100 MB (闲置), < 200 MB (处理中)
- CPU 占用: < 5% (闲置), < 30% (录音/处理)
- 磁盘空间: < 50 MB (安装), 临时文件自动清理

### 可靠性
- 快捷键响应率: 99.9%
- API 失败重试: 最多 3 次，指数退避
- 崩溃恢复: 自动重启后台服务

## 安全和隐私

### 数据处理
- 音频文件仅存储在本地临时目录
- 处理完成后立即删除音频文件
- API 通信使用 HTTPS
- 不收集任何用户数据或遥测

### API Key 安全
- API Key 存储在 `.env` 文件（不提交到 git）
- 引导用户正确配置文件权限 (`chmod 600`)
- 错误日志不输出完整 API Key

### 权限最小化
- 仅请求必需的系统权限
- 明确告知用户每个权限的用途
- 提供权限授予教程

## 平台兼容性

### macOS
- 最低版本: macOS 11 (Big Sur)
- 权限需求: 麦克风访问、辅助功能
- 安装方式: Homebrew 或 npm global

### Linux
- 发行版: Ubuntu 20.04+, Fedora 35+, Arch
- 依赖: `sox`, `xdotool` (通过包管理器安装)
- 安装方式: npm global

### Windows
- 最低版本: Windows 10
- 可能需要管理员权限（首次运行）
- 安装方式: npm global 或 Scoop

## 成本分析

### API 使用成本
**假设**: 每天 100 次使用，每次 20 秒

- Whisper API: 100 × 20/60 × $0.006 = **$0.20/天**
- GPT-4o-mini: 100 × ~$0.00002 = **$0.002/天**
- **总计**: ~$0.20/天 = **$6/月**

### 对比
- Typeless: ~$30/月 → **节省 80%**
- Azure Speech: ~$15/月 → **节省 60%**

## 成功标准

### MVP (v1.0) 必须实现
- ✅ 全局快捷键工作正常
- ✅ 录音质量满足 Whisper 要求
- ✅ 转录准确率 > 95%（英文）
- ✅ 格式化符合预期（Slack/Email 风格）
- ✅ 文本成功插入到至少 5 种常见应用
- ✅ macOS 和 Linux 平台完整支持

### 未来迭代（v2.0+）
- 支持本地 Whisper（whisper.cpp）
- 支持自定义格式化 prompt
- 多语言支持（中文、西班牙语等）
- 历史记录和统计
- GUI 配置界面（Electron 版本）

## 实现优先级

### Phase 1: 核心功能（1-2 天）
1. 快捷键监听 + 录音
2. Whisper API 集成
3. GPT-4o-mini 格式化
4. 剪贴板文本插入
5. 基础错误处理

### Phase 2: 用户体验（0.5-1 天）
1. 美化终端输出（chalk + ora）
2. 进度指示和状态反馈
3. 权限检查和引导
4. 配置文件支持

### Phase 3: 优化和测试（0.5 天）
1. 性能优化
2. 跨平台测试
3. 边界情况处理
4. 文档完善

## 开发指南

### 安装和启动
```bash
# 1. 克隆项目
git clone <repo>
cd voice-input-cli

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY

# 4. 开发模式
npm run dev

# 5. 构建
npm run build

# 6. 本地安装
npm link

# 7. 使用
voice-input
```

### 测试策略
```bash
# 单元测试
npm test

# 集成测试
npm run test:integration

# 手动测试检查清单
- [ ] 快捷键在 Slack 中工作
- [ ] 快捷键在 Terminal 中工作
- [ ] 快捷键在浏览器中工作
- [ ] 长文本（>100 字）正确插入
- [ ] 特殊字符和 Emoji 正确处理
- [ ] 网络断开时有清晰错误提示
- [ ] 剪贴板恢复功能正常
```

## 文档需求

### README.md 必须包含
1. 产品介绍和演示 GIF
2. 快速开始（安装 + 配置）
3. 权限授予教程（各平台截图）
4. 故障排除（常见问题）
5. 成本估算说明
6. 与 Typeless 的对比

### 技术文档
1. 架构设计文档
2. API 使用说明
3. 贡献指南
4. 发布流程

## 备注和注意事项

1. **权限处理是关键**: 必须有清晰的权限引导，否则用户会卡住
2. **错误信息要友好**: 每个错误都要给出明确的解决方案
3. **性能很重要**: 用户期望快速响应，优化 API 调用和音频处理
4. **测试要充分**: 在多个应用中测试文本插入，确保兼容性
5. **文档要完善**: CLI 工具的文档质量直接影响用户体验

## 交付物清单

- [ ] 完整可运行的 CLI 工具
- [ ] npm package 配置（可发布到 npm）
- [ ] README 和使用文档
- [ ] 权限授予教程（带截图）
- [ ] `.env.example` 模板
- [ ] 错误处理和日志系统
- [ ] 跨平台兼容性验证报告

---

**预期开发时间**: 2-3 天（单人全职）  
**最小可用版本**: 1 天可完成核心功能