const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class DuomiVideoGenerator extends EventEmitter {
    constructor() {
        super();
        this.mcpProcess = null;
        this.requestId = 1;
        this.pendingRequests = new Map();
        this.videos = new Map(); // 存储视频生成任务
    }

    // 启动MCP服务器
    async startMCPServer() {
        return new Promise((resolve, reject) => {
            console.log('启动duomi-video MCP服务器...');
            
            // Windows兼容性：使用npx.cmd
            const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            
            this.mcpProcess = spawn(command, ['duomi-video-mcp', 'duomi-video-mcp-server'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: process.platform === 'win32', // Windows需要shell模式
                env: {
                    ...process.env,
                    DUOMI_API_KEY: 'Zs7JfSUEioQWm4WJm96PdmrpsY',
                    DUOMI_MODEL_NAME: 'kling-v1'
                }
            });

            let initComplete = false;

            this.mcpProcess.stdout.on('data', (data) => {
                const messages = data.toString().split('\n').filter(line => line.trim());
                
                for (const message of messages) {
                    try {
                        const parsed = JSON.parse(message);
                        this.handleMCPMessage(parsed);
                        
                        if (!initComplete && parsed.method === 'notifications/initialized') {
                            initComplete = true;
                            resolve();
                        }
                    } catch (e) {
                        // 忽略非JSON消息
                    }
                }
            });

            this.mcpProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                console.error('MCP Info:', errorMsg);
                
                // 检查服务器启动消息
                if (!initComplete && errorMsg.includes('MCP server running')) {
                    console.log('✅ MCP服务器已启动');
                    initComplete = true;
                    resolve();
                }
                
                // 如果是关键错误，立即拒绝
                if (!initComplete && errorMsg.includes('Error') && !errorMsg.includes('MCP server running')) {
                    reject(new Error(`MCP服务器启动错误: ${errorMsg}`));
                }
            });

            this.mcpProcess.on('error', (error) => {
                console.error('MCP进程错误:', error.message);
                if (!initComplete) {
                    reject(new Error(`MCP服务器进程启动失败: ${error.message}`));
                }
            });

            this.mcpProcess.on('close', (code) => {
                console.log(`MCP服务器退出，代码: ${code}`);
                if (!initComplete) {
                    reject(new Error(`MCP服务器启动失败，退出代码: ${code}`));
                }
            });

            // 等待服务器启动，如果3秒内没有收到启动消息则认为已启动
            setTimeout(() => {
                if (!initComplete) {
                    console.log('✅ MCP服务器启动完成（超时方式）');
                    initComplete = true;
                    resolve();
                }
            }, 3000);
        });
    }

    // 处理MCP消息
    handleMCPMessage(message) {
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);
            
            if (message.error) {
                reject(new Error(message.error.message || 'MCP调用失败'));
            } else {
                resolve(message.result);
            }
        }
    }

    // 发送MCP消息
    sendMCPMessage(message) {
        if (this.mcpProcess && this.mcpProcess.stdin.writable) {
            this.mcpProcess.stdin.write(JSON.stringify(message) + '\n');
        }
    }

    // 调用MCP工具
    async callTool(toolName, parameters) {
        return new Promise((resolve, reject) => {
            const id = this.requestId++;
            
            this.pendingRequests.set(id, { resolve, reject });
            
            this.sendMCPMessage({
                jsonrpc: '2.0',
                id: id,
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: parameters
                }
            });

            // 设置超时
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`工具调用超时: ${toolName}`));
                }
            }, 60000); // 60秒超时
        });
    }

    // 生成视频
    async generateVideo(prompt, title = '') {
        try {
            console.log(`\n🎬 开始生成视频: ${title || prompt.substring(0, 50)}...`);
            
            const result = await this.callTool('generate_video', { prompt });
            
            if (result && result.content && result.content[0] && result.content[0].text) {
                const response = JSON.parse(result.content[0].text);
                
                if (response.task_id) {
                    console.log(`✅ 视频生成任务创建成功，任务ID: ${response.task_id}`);
                    
                    const videoTask = {
                        taskId: response.task_id,
                        prompt: prompt,
                        title: title,
                        status: 'pending',
                        createdAt: new Date(),
                        attempts: 0
                    };
                    
                    this.videos.set(response.task_id, videoTask);
                    return response.task_id;
                } else {
                    throw new Error('生成视频失败: 未返回任务ID');
                }
            } else {
                throw new Error('生成视频失败: 响应格式错误');
            }
        } catch (error) {
            console.error(`❌ 生成视频失败: ${error.message}`);
            throw error;
        }
    }

    // 检查视频状态
    async checkVideoStatus(taskId) {
        try {
            const result = await this.callTool('get_video_status', { task_id: taskId });
            
            if (result && result.content && result.content[0] && result.content[0].text) {
                const response = JSON.parse(result.content[0].text);
                return response;
            } else {
                throw new Error('获取视频状态失败: 响应格式错误');
            }
        } catch (error) {
            console.error(`❌ 检查视频状态失败 (${taskId}): ${error.message}`);
            throw error;
        }
    }

    // 轮询视频状态直到完成
    async waitForVideoCompletion(taskId, maxAttempts = 60) {
        const videoTask = this.videos.get(taskId);
        if (!videoTask) {
            throw new Error(`未找到任务: ${taskId}`);
        }

        console.log(`⏳ 开始轮询视频状态: ${videoTask.title || videoTask.prompt.substring(0, 30)}...`);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                videoTask.attempts = attempt;
                const status = await this.checkVideoStatus(taskId);
                
                console.log(`📊 第 ${attempt} 次检查 - 状态: ${status.state} (${status.status})`);
                
                if (status.state === 'succeeded' && status.status === '3') {
                    videoTask.status = 'completed';
                    videoTask.videoUrl = status.video_url;
                    videoTask.completedAt = new Date();
                    
                    console.log(`🎉 视频生成完成！`);
                    console.log(`📹 视频链接: ${status.video_url}`);
                    
                    return {
                        taskId: taskId,
                        title: videoTask.title,
                        prompt: videoTask.prompt,
                        videoUrl: status.video_url,
                        poster: status.poster || '',
                        status: status
                    };
                } else if (status.state === 'failed') {
                    videoTask.status = 'failed';
                    throw new Error(`视频生成失败: ${status.msg || '未知错误'}`);
                } else if (status.state === 'running') {
                    // 继续等待
                    console.log(`⚡ 视频正在生成中... (${attempt}/${maxAttempts})`);
                    
                    if (attempt < maxAttempts) {
                        await this.sleep(30000); // 等待30秒
                    }
                } else {
                    console.log(`🔄 未知状态: ${status.state}, 继续等待...`);
                    
                    if (attempt < maxAttempts) {
                        await this.sleep(30000);
                    }
                }
            } catch (error) {
                console.error(`❌ 检查状态时出错 (尝试 ${attempt}/${maxAttempts}): ${error.message}`);
                
                if (attempt < maxAttempts) {
                    console.log(`🔄 30秒后重试...`);
                    await this.sleep(30000);
                } else {
                    throw error;
                }
            }
        }

        videoTask.status = 'timeout';
        throw new Error(`视频生成超时，已尝试 ${maxAttempts} 次`);
    }

    // 批量生成视频
    async batchGenerateVideos(prompts, options = {}) {
        const {
            maxConcurrent = 3, // 最大并发数
            delayBetweenRequests = 5000, // 请求间隔（毫秒）
            maxAttempts = 60 // 每个视频的最大轮询次数
        } = options;

        console.log(`\n🚀 开始批量生成 ${prompts.length} 个视频`);
        console.log(`⚙️  最大并发数: ${maxConcurrent}, 请求间隔: ${delayBetweenRequests}ms`);

        const results = [];
        const failed = [];

        // 分批处理
        for (let i = 0; i < prompts.length; i += maxConcurrent) {
            const batch = prompts.slice(i, i + maxConcurrent);
            console.log(`\n📦 处理第 ${Math.floor(i / maxConcurrent) + 1} 批 (${batch.length} 个视频)`);

            // 并发生成视频任务
            const batchTasks = [];
            for (const promptItem of batch) {
                const prompt = typeof promptItem === 'string' ? promptItem : promptItem.prompt;
                const title = typeof promptItem === 'object' ? promptItem.title || '' : '';
                
                batchTasks.push(
                    this.generateVideoWithRetry(prompt, title, maxAttempts)
                        .then(result => ({ success: true, result }))
                        .catch(error => ({ success: false, error, prompt, title }))
                );

                // 添加请求间隔
                if (batchTasks.length > 1) {
                    await this.sleep(delayBetweenRequests);
                }
            }

            // 等待当前批次完成
            const batchResults = await Promise.all(batchTasks);
            
            // 收集结果
            for (const batchResult of batchResults) {
                if (batchResult.success) {
                    results.push(batchResult.result);
                } else {
                    failed.push({
                        prompt: batchResult.prompt,
                        title: batchResult.title,
                        error: batchResult.error.message
                    });
                }
            }

            console.log(`✅ 第 ${Math.floor(i / maxConcurrent) + 1} 批完成`);
        }

        return {
            success: results,
            failed: failed,
            total: prompts.length,
            successCount: results.length,
            failedCount: failed.length
        };
    }

    // 带重试的视频生成
    async generateVideoWithRetry(prompt, title = '', maxAttempts = 60) {
        const taskId = await this.generateVideo(prompt, title);
        return await this.waitForVideoCompletion(taskId, maxAttempts);
    }

    // 获取所有视频状态
    getVideoStats() {
        const stats = {
            total: this.videos.size,
            pending: 0,
            completed: 0,
            failed: 0,
            timeout: 0
        };

        for (const video of this.videos.values()) {
            stats[video.status]++;
        }

        return stats;
    }

    // 导出结果到文件
    async exportResults(results, filename = `video_results_${Date.now()}.json`) {
        const fs = require('fs').promises;
        
        const exportData = {
            timestamp: new Date().toISOString(),
            summary: {
                total: results.total,
                success: results.successCount,
                failed: results.failedCount
            },
            successful_videos: results.success,
            failed_videos: results.failed,
            video_stats: this.getVideoStats()
        };

        await fs.writeFile(filename, JSON.stringify(exportData, null, 2), 'utf8');
        console.log(`📄 结果已导出到: ${filename}`);
        
        return filename;
    }

    // 工具函数：睡眠
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 关闭MCP服务器
    async close() {
        if (this.mcpProcess) {
            this.mcpProcess.kill();
            this.mcpProcess = null;
        }
    }
}

// 使用示例
async function main() {
    const generator = new DuomiVideoGenerator();

    try {
        // 启动MCP服务器
        await generator.startMCPServer();
        console.log('✅ MCP服务器启动成功');

        // 定义要生成的视频提示
        const prompts = [
            {
                title: "老人与海",
                prompt: "An old fisherman in a small boat struggles with a giant marlin in the open sea. Epic battle between man and nature, inspired by Hemingway's 'The Old Man and the Sea'."
            },
            {
                title: "城市夜景",
                prompt: "A vibrant city skyline at night with neon lights reflecting on wet streets after rain. Modern urban landscape with bustling traffic and glowing windows."
            },
            {
                title: "森林晨曦",
                prompt: "Sunlight filtering through tall pine trees in a misty morning forest. Peaceful nature scene with golden rays and gentle fog."
            }
        ];

        // 批量生成视频
        const results = await generator.batchGenerateVideos(prompts, {
            maxConcurrent: 2,      // 最大并发数
            delayBetweenRequests: 3000,  // 请求间隔3秒
            maxAttempts: 60        // 每个视频最多轮询60次（30分钟）
        });

        // 显示结果汇总
        console.log('\n📊 批量生成完成！');
        console.log(`✅ 成功: ${results.successCount}/${results.total}`);
        console.log(`❌ 失败: ${results.failedCount}/${results.total}`);

        // 显示成功的视频
        if (results.success.length > 0) {
            console.log('\n🎬 成功生成的视频:');
            results.success.forEach((video, index) => {
                console.log(`${index + 1}. ${video.title || video.prompt.substring(0, 50)}`);
                console.log(`   📹 链接: ${video.videoUrl}`);
                console.log(`   🆔 任务ID: ${video.taskId}`);
            });
        }

        // 显示失败的视频
        if (results.failed.length > 0) {
            console.log('\n❌ 生成失败的视频:');
            results.failed.forEach((failure, index) => {
                console.log(`${index + 1}. ${failure.title || failure.prompt.substring(0, 50)}`);
                console.log(`   💥 错误: ${failure.error}`);
            });
        }

        // 导出结果
        await generator.exportResults(results);

    } catch (error) {
        console.error('❌ 执行失败:', error.message);
    } finally {
        // 关闭MCP服务器
        await generator.close();
        console.log('\n🔚 程序结束');
    }
}

// 如果直接运行这个文件
if (require.main === module) {
    main().catch(console.error);
}

module.exports = DuomiVideoGenerator;
