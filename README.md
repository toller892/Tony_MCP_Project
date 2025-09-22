# Duomi批量视频生成器使用流程

## 概述

这是一个基于Node.js的批量视频生成工具，通过MCP (Model Context Protocol) 协议与Duomi API通信，实现批量创建AI视频的功能。

## 主要特性

- 🎬 **批量生成**: 支持同时处理多个视频生成任务
- ⚡ **并发控制**: 可配置最大并发数，避免API限流
- 🔄 **自动轮询**: 自动检查视频生成状态直到完成
- 📊 **进度监控**: 实时显示生成进度和统计信息
- 💾 **结果导出**: 自动导出详细的处理结果报告
- 🛡️ **错误处理**: 完善的错误处理和重试机制

## 系统架构

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Node.js应用    │───▶│   MCP服务器     │───▶│   Duomi API     │
│ (批量视频生成器) │    │ (协议转换桥梁)   │    │ (AI视频生成服务) │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 核心流程

### 1. 环境准备
```bash
# 安装依赖
npm install

# 确保已安装duomi-video-mcp包
npm install duomi-video-mcp
```

### 2. 配置API密钥
在代码中配置您的Duomi API密钥：
```javascript
env: {
    DUOMI_API_KEY: 'your-api-key-here',
    DUOMI_MODEL_NAME: 'kling-v1'
}
```

### 3. 准备视频提示词
定义要生成的视频描述：
```javascript
const prompts = [
    {
        title: "视频标题",
        prompt: "详细的视频描述文本（英文效果更好）"
    },
    // 或者简单的字符串格式
    "视频描述文本"
];
```

### 4. 配置批量处理参数
```javascript
const options = {
    maxConcurrent: 2,          // 最大并发数
    delayBetweenRequests: 3000, // 请求间隔(毫秒)
    maxAttempts: 60            // 最大轮询次数
};
```

### 5. 执行批量生成
```javascript
const results = await generator.batchGenerateVideos(prompts, options);
```
### 6.执行命令
```
node batch_video_generator.js
```

## 详细步骤说明

### 步骤1: 启动MCP服务器
- **目的**: 建立与Duomi API的通信通道
- **时间**: 通常需要3-5秒
- **状态**: 等待服务器启动完成或超时

### 步骤2: 创建视频生成任务
- **操作**: 为每个提示词创建生成任务
- **返回**: 获得唯一的任务ID
- **并发**: 根据配置控制同时创建的任务数量

### 步骤3: 轮询任务状态
- **频率**: 每30秒检查一次
- **状态类型**:
  - `pending`: 任务排队中
  - `running`: 正在生成
  - `succeeded`: 生成成功
  - `failed`: 生成失败

### 步骤4: 收集结果
- **成功**: 获得视频URL和相关信息
- **失败**: 记录错误原因
- **统计**: 汇总成功/失败数量

### 步骤5: 导出报告
- **格式**: JSON文件
- **内容**: 包含所有视频信息、统计数据和错误详情
- **文件名**: `video_results_时间戳.json`

## 状态说明

### 任务状态
| 状态 | 说明 | 后续操作 |
|------|------|----------|
| pending | 任务已创建，等待处理 | 继续轮询 |
| running | 视频正在生成中 | 继续轮询 |
| succeeded | 视频生成成功 | 获取视频URL |
| failed | 视频生成失败 | 记录错误信息 |
| timeout | 轮询超时 | 标记为超时失败 |

### 轮询机制
- **间隔**: 30秒检查一次
- **超时**: 默认60次尝试（30分钟）
- **重试**: 网络错误时自动重试

## 配置参数详解

### maxConcurrent (最大并发数)
- **默认值**: 3
- **建议范围**: 1-5
- **说明**: 同时处理的视频数量，过大可能导致API限流

### delayBetweenRequests (请求间隔)
- **默认值**: 5000ms (5秒)
- **建议范围**: 3000-10000ms
- **说明**: 避免请求过于频繁被API拒绝

### maxAttempts (最大轮询次数)
- **默认值**: 60次 (30分钟)
- **建议范围**: 30-120次
- **说明**: 每个视频的最大等待时间

## 输出文件格式

生成的JSON报告包含以下结构：
```json
{
  "timestamp": "2024-01-01T12:00:00.000Z",
  "summary": {
    "total": 3,
    "success": 2,
    "failed": 1
  },
  "successful_videos": [
    {
      "taskId": "xxx",
      "title": "视频标题",
      "prompt": "视频描述",
      "videoUrl": "https://...",
      "poster": "缩略图URL"
    }
  ],
  "failed_videos": [
    {
      "prompt": "失败的视频描述",
      "title": "视频标题",
      "error": "错误原因"
    }
  ],
  "video_stats": {
    "total": 3,
    "completed": 2,
    "failed": 1,
    "timeout": 0
  }
}
```

## 使用示例

```javascript
const DuomiVideoGenerator = require('./batch_video_generator');

async function generateMyVideos() {
    const generator = new DuomiVideoGenerator();
    
    try {
        await generator.startMCPServer();
        
        const prompts = [
            "A beautiful sunset over the ocean",
            "A cat playing in a garden",
            "City traffic at night with neon lights"
        ];
        
        const results = await generator.batchGenerateVideos(prompts, {
            maxConcurrent: 2,
            delayBetweenRequests: 3000,
            maxAttempts: 40
        });
        
        console.log(`生成完成: ${results.successCount}/${results.total}`);
        
    } finally {
        await generator.close();
    }
}
```

## 注意事项

1. **API限制**: 
   - 注意Duomi API的并发限制和配额
   - 合理设置并发数和请求间隔

2. **网络稳定性**:
   - 确保网络连接稳定
   - 程序会自动重试网络错误

3. **资源管理**:
   - 程序结束时会自动清理MCP服务器进程
   - 建议在finally块中调用close()方法

4. **提示词质量**:
   - 使用英文描述通常效果更好
   - 提供详细、具体的场景描述
   - 避免过于复杂或模糊的描述

5. **时间估算**:
   - 每个视频生成通常需要5-15分钟
   - 批量处理时间 = 视频数量 × 平均生成时间 ÷ 并发数

## 故障排除

### 常见问题

1. **MCP服务器启动失败**
   - 检查网络连接
   - 确认API密钥正确
   - 重启程序重试

2. **视频生成超时**
   - 增加maxAttempts值
   - 检查提示词是否过于复杂
   - 稍后重试

3. **API限流错误**
   - 减少并发数
   - 增加请求间隔
   - 检查API配额

4. **内存占用过高**
   - 减少并发数
   - 分批处理大量视频

## 技术支持

如果遇到问题，请检查：
1. Node.js版本是否兼容
2. 网络连接是否正常
3. API密钥是否有效
4. 系统资源是否充足

---

*此文档对应batch_video_generator.js v1.0版本*
