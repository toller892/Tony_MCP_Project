// 导入Node.js核心模块
const { spawn } = require('child_process');  // 用于启动子进程
const { EventEmitter } = require('events');  // 事件发射器，用于处理异步事件

/**
 * Duomi视频生成器类
 * 继承自EventEmitter，支持事件驱动的异步操作
 */
class DuomiVideoGenerator extends EventEmitter {
    constructor() {
        super();
        this.mcpProcess = null;           // MCP服务器进程实例
        this.requestId = 1;               // 请求ID计数器，用于跟踪每个MCP请求
        this.pendingRequests = new Map(); // 存储待处理的MCP请求
        this.videos = new Map();          // 存储视频生成任务的状态信息
    }

    /**
     * 启动MCP服务器
     * MCP (Model Context Protocol) 是用于与AI模型服务通信的协议
     * @returns {Promise} 返回启动成功或失败的Promise
     */
    async startMCPServer() {
        return new Promise((resolve, reject) => {
            console.log('启动duomi-video MCP服务器...');
            
            // Windows兼容性处理：Windows系统使用npx.cmd，其他系统使用npx
            const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            
            // 启动MCP服务器子进程
            this.mcpProcess = spawn(command, ['duomi-video-mcp', 'duomi-video-mcp-server'], {
                stdio: ['pipe', 'pipe', 'pipe'],      // 配置标准输入输出流
                shell: process.platform === 'win32',  // Windows系统需要shell模式
                env: {
                    ...process.env,                           // 继承当前环境变量
                    DUOMI_API_KEY: 'Zs7JfSUEioQWm4WJm96PdmrpsY',  // Duomi API密钥
                    DUOMI_MODEL_NAME: 'kling-v1'              // 指定使用的模型版本
                }
            });

            let initComplete = false;  // 标记MCP服务器是否初始化完成

            // 监听MCP服务器的标准输出，处理JSON格式的消息
            this.mcpProcess.stdout.on('data', (data) => {
                // 将接收到的数据转换为字符串，按行分割，过滤空行
                const messages = data.toString().split('\n').filter(line => line.trim());
                
                // 逐条处理消息
                for (const message of messages) {
                    try {
                        // 尝试解析JSON消息
                        const parsed = JSON.parse(message);
                        this.handleMCPMessage(parsed);  // 处理MCP消息
                        
                        // 检查是否收到初始化完成通知
                        if (!initComplete && parsed.method === 'notifications/initialized') {
                            initComplete = true;
                            resolve();  // 服务器初始化完成，解决Promise
                        }
                    } catch (e) {
                        // 忽略非JSON格式的消息（如调试信息等）
                    }
                }
            });

            // 监听MCP服务器的标准错误输出
            this.mcpProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                console.error('MCP Info:', errorMsg);
                
                // 检查服务器启动成功消息（有些启动信息会输出到stderr）
                if (!initComplete && errorMsg.includes('MCP server running')) {
                    console.log('✅ MCP服务器已启动');
                    initComplete = true;
                    resolve();  // 服务器启动成功，解决Promise
                }
                
                // 检查是否为关键错误，如果是则立即拒绝Promise
                if (!initComplete && errorMsg.includes('Error') && !errorMsg.includes('MCP server running')) {
                    reject(new Error(`MCP服务器启动错误: ${errorMsg}`));
                }
            });

            // 监听MCP进程错误事件
            this.mcpProcess.on('error', (error) => {
                console.error('MCP进程错误:', error.message);
                if (!initComplete) {
                    reject(new Error(`MCP服务器进程启动失败: ${error.message}`));
                }
            });

            // 监听MCP进程关闭事件
            this.mcpProcess.on('close', (code) => {
                console.log(`MCP服务器退出，代码: ${code}`);
                if (!initComplete) {
                    reject(new Error(`MCP服务器启动失败，退出代码: ${code}`));
                }
            });

            // 设置超时机制：如果3秒内没有收到明确的启动消息，则认为服务器已启动
            // 这是一个备用机制，防止某些情况下启动消息丢失导致程序卡死
            setTimeout(() => {
                if (!initComplete) {
                    console.log('✅ MCP服务器启动完成（超时方式）');
                    initComplete = true;
                    resolve();
                }
            }, 3000);  // 3秒超时
        });
    }

    /**
     * 处理从MCP服务器收到的消息
     * 根据消息ID匹配对应的Promise，并解决或拒绝它
     * @param {Object} message - MCP服务器返回的消息对象
     */
    handleMCPMessage(message) {
        // 检查消息是否有ID且存在对应的待处理请求
        if (message.id && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id);
            this.pendingRequests.delete(message.id);  // 从待处理列表中移除
            
            // 根据消息内容决定是解决还是拒绝Promise
            if (message.error) {
                reject(new Error(message.error.message || 'MCP调用失败'));
            } else {
                resolve(message.result);
            }
        }
    }

    /**
     * 向MCP服务器发送消息
     * @param {Object} message - 要发送的消息对象（JSON格式）
     */
    sendMCPMessage(message) {
        // 检查MCP进程是否存在且标准输入流可写
        if (this.mcpProcess && this.mcpProcess.stdin.writable) {
            // 将消息序列化为JSON字符串并发送，添加换行符表示消息结束
            this.mcpProcess.stdin.write(JSON.stringify(message) + '\n');
        }
    }

    /**
     * 调用MCP工具
     * 通过MCP协议调用远程工具（如视频生成、状态查询等）
     * @param {string} toolName - 工具名称
     * @param {Object} parameters - 工具参数
     * @returns {Promise} 返回工具调用结果的Promise
     */
    async callTool(toolName, parameters) {
        return new Promise((resolve, reject) => {
            const id = this.requestId++;  // 生成唯一的请求ID
            
            // 将请求存储到待处理映射中，以便后续匹配响应
            this.pendingRequests.set(id, { resolve, reject });
            
            // 构造并发送MCP工具调用消息
            this.sendMCPMessage({
                jsonrpc: '2.0',           // JSON-RPC协议版本
                id: id,                   // 请求ID
                method: 'tools/call',     // 调用工具的方法
                params: {
                    name: toolName,       // 工具名称
                    arguments: parameters // 工具参数
                }
            });

            // 设置60秒超时机制，防止请求无限等待
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`工具调用超时: ${toolName}`));
                }
            }, 60000); // 60秒超时
        });
    }

    /**
     * 生成视频
     * 向Duomi API发送视频生成请求，创建视频生成任务
     * @param {string} prompt - 视频生成的文本描述
     * @param {string} title - 视频标题（可选）
     * @returns {Promise<string>} 返回任务ID
     */
    async generateVideo(prompt, title = '') {
        try {
            console.log(`\n🎬 开始生成视频: ${title || prompt.substring(0, 50)}...`);
            
            // 调用MCP工具生成视频
            const result = await this.callTool('generate_video', { prompt });
            
            // 验证返回结果的格式
            if (result && result.content && result.content[0] && result.content[0].text) {
                const response = JSON.parse(result.content[0].text);
                
                // 检查是否成功获取任务ID
                if (response.task_id) {
                    console.log(`✅ 视频生成任务创建成功，任务ID: ${response.task_id}`);
                    
                    // 创建视频任务对象，保存任务状态信息
                    const videoTask = {
                        taskId: response.task_id,  // 任务ID
                        prompt: prompt,            // 生成提示词
                        title: title,              // 视频标题
                        status: 'pending',         // 任务状态：待处理
                        createdAt: new Date(),     // 创建时间
                        attempts: 0                // 轮询尝试次数
                    };
                    
                    // 将任务信息存储到内存中
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

    /**
     * 检查视频生成状态
     * 查询指定任务ID的视频生成进度和状态
     * @param {string} taskId - 视频生成任务ID
     * @returns {Promise<Object>} 返回包含视频状态信息的对象
     */
    async checkVideoStatus(taskId) {
        try {
            // 调用MCP工具查询视频状态
            const result = await this.callTool('get_video_status', { task_id: taskId });
            
            // 验证返回结果的格式
            if (result && result.content && result.content[0] && result.content[0].text) {
                const response = JSON.parse(result.content[0].text);
                return response;  // 返回状态信息对象
            } else {
                throw new Error('获取视频状态失败: 响应格式错误');
            }
        } catch (error) {
            console.error(`❌ 检查视频状态失败 (${taskId}): ${error.message}`);
            throw error;
        }
    }

    /**
     * 轮询视频状态直到完成
     * 持续检查视频生成状态，直到成功、失败或超时
     * @param {string} taskId - 视频生成任务ID
     * @param {number} maxAttempts - 最大轮询次数，默认60次（30分钟）
     * @returns {Promise<Object>} 返回完成的视频信息对象
     */
    async waitForVideoCompletion(taskId, maxAttempts = 60) {
        const videoTask = this.videos.get(taskId);
        if (!videoTask) {
            throw new Error(`未找到任务: ${taskId}`);
        }

        console.log(`⏳ 开始轮询视频状态: ${videoTask.title || videoTask.prompt.substring(0, 30)}...`);

        // 开始轮询循环，每30秒检查一次状态
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                videoTask.attempts = attempt;  // 记录尝试次数
                const status = await this.checkVideoStatus(taskId);  // 查询当前状态
                
                console.log(`📊 第 ${attempt} 次检查 - 状态: ${status.state} (${status.status})`);
                
                // 检查是否生成成功（state为'succeeded'且status为'3'表示完成）
                if (status.state === 'succeeded' && status.status === '3') {
                    videoTask.status = 'completed';
                    videoTask.videoUrl = status.video_url;
                    videoTask.completedAt = new Date();
                    
                    console.log(`🎉 视频生成完成！`);
                    console.log(`📹 视频链接: ${status.video_url}`);
                    
                    // 返回完整的视频信息对象
                    return {
                        taskId: taskId,
                        title: videoTask.title,
                        prompt: videoTask.prompt,
                        videoUrl: status.video_url,
                        poster: status.poster || '',  // 视频缩略图
                        status: status
                    };
                } else if (status.state === 'failed') {
                    // 生成失败，更新状态并抛出错误
                    videoTask.status = 'failed';
                    throw new Error(`视频生成失败: ${status.msg || '未知错误'}`);
                } else if (status.state === 'running') {
                    // 视频仍在生成中，继续等待
                    console.log(`⚡ 视频正在生成中... (${attempt}/${maxAttempts})`);
                    
                    if (attempt < maxAttempts) {
                        await this.sleep(30000); // 等待30秒后再次检查
                    }
                } else {
                    // 未知状态，继续等待
                    console.log(`🔄 未知状态: ${status.state}, 继续等待...`);
                    
                    if (attempt < maxAttempts) {
                        await this.sleep(30000);
                    }
                }
            } catch (error) {
                console.error(`❌ 检查状态时出错 (尝试 ${attempt}/${maxAttempts}): ${error.message}`);
                
                // 如果不是最后一次尝试，则等待30秒后重试
                if (attempt < maxAttempts) {
                    console.log(`🔄 30秒后重试...`);
                    await this.sleep(30000);
                } else {
                    throw error;  // 最后一次尝试失败，抛出错误
                }
            }
        }

        // 超过最大尝试次数，标记为超时
        videoTask.status = 'timeout';
        throw new Error(`视频生成超时，已尝试 ${maxAttempts} 次`);
    }

    /**
     * 批量生成视频
     * 同时处理多个视频生成请求，支持并发控制和请求间隔
     * @param {Array} prompts - 视频提示词数组，可以是字符串数组或对象数组
     * @param {Object} options - 批量处理选项
     * @param {number} options.maxConcurrent - 最大并发处理数，默认3
     * @param {number} options.delayBetweenRequests - 请求间隔毫秒数，默认5000
     * @param {number} options.maxAttempts - 每个视频的最大轮询次数，默认60
     * @returns {Promise<Object>} 返回包含成功和失败结果的汇总对象
     */
    async batchGenerateVideos(prompts, options = {}) {
        const {
            maxConcurrent = 3,              // 最大并发数（防止API限流）
            delayBetweenRequests = 5000,    // 请求间隔毫秒数（避免请求过于频繁）
            maxAttempts = 60                // 每个视频的最大轮询次数（30分钟超时）
        } = options;

        console.log(`\n🚀 开始批量生成 ${prompts.length} 个视频`);
        console.log(`⚙️  最大并发数: ${maxConcurrent}, 请求间隔: ${delayBetweenRequests}ms`);

        const results = [];   // 存储成功的视频结果
        const failed = [];    // 存储失败的视频信息

        // 按最大并发数分批处理，避免同时发起过多请求
        for (let i = 0; i < prompts.length; i += maxConcurrent) {
            const batch = prompts.slice(i, i + maxConcurrent);  // 获取当前批次的提示词
            console.log(`\n📦 处理第 ${Math.floor(i / maxConcurrent) + 1} 批 (${batch.length} 个视频)`);

            // 为当前批次创建并发任务
            const batchTasks = [];
            for (const promptItem of batch) {
                // 支持两种格式：字符串或包含prompt和title的对象
                const prompt = typeof promptItem === 'string' ? promptItem : promptItem.prompt;
                const title = typeof promptItem === 'object' ? promptItem.title || '' : '';
                
                // 创建异步任务，使用Promise包装确保错误不会中断其他任务
                batchTasks.push(
                    this.generateVideoWithRetry(prompt, title, maxAttempts)
                        .then(result => ({ success: true, result }))      // 成功时的结果格式
                        .catch(error => ({ success: false, error, prompt, title }))  // 失败时的错误格式
                );

                // 在任务间添加延迟，避免请求过于密集
                if (batchTasks.length > 1) {
                    await this.sleep(delayBetweenRequests);
                }
            }

            // 等待当前批次的所有任务完成（成功或失败）
            const batchResults = await Promise.all(batchTasks);
            
            // 分类收集结果：成功的放入results，失败的放入failed
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

        // 返回批量处理的汇总结果
        return {
            success: results,               // 成功生成的视频数组
            failed: failed,                 // 失败的视频数组
            total: prompts.length,          // 总数
            successCount: results.length,   // 成功数量
            failedCount: failed.length      // 失败数量
        };
    }

    /**
     * 带重试的视频生成
     * 组合视频生成和状态轮询的便捷方法
     * @param {string} prompt - 视频生成的文本描述
     * @param {string} title - 视频标题，默认为空字符串
     * @param {number} maxAttempts - 最大轮询次数，默认60次
     * @returns {Promise<Object>} 返回完成的视频信息对象
     */
    async generateVideoWithRetry(prompt, title = '', maxAttempts = 60) {
        // 先创建视频生成任务，获取任务ID
        const taskId = await this.generateVideo(prompt, title);
        // 然后等待视频生成完成
        return await this.waitForVideoCompletion(taskId, maxAttempts);
    }

    /**
     * 获取所有视频的统计信息
     * 统计各种状态的视频数量，用于监控批量处理进度
     * @returns {Object} 返回包含各状态视频数量的统计对象
     */
    getVideoStats() {
        const stats = {
            total: this.videos.size,    // 总视频数
            pending: 0,                 // 待处理数
            completed: 0,               // 已完成数
            failed: 0,                  // 失败数
            timeout: 0                  // 超时数
        };

        // 遍历所有视频任务，统计各状态的数量
        for (const video of this.videos.values()) {
            stats[video.status]++;
        }

        return stats;
    }

    /**
     * 导出处理结果到JSON文件
     * 将批量处理的结果保存为结构化的JSON文件，便于后续分析
     * @param {Object} results - 批量处理的结果对象
     * @param {string} filename - 导出文件名，默认使用时间戳命名
     * @returns {Promise<string>} 返回导出的文件名
     */
    async exportResults(results, filename = `video_results_${Date.now()}.json`) {
        const fs = require('fs').promises;
        
        // 构造导出数据结构
        const exportData = {
            timestamp: new Date().toISOString(),   // 导出时间戳
            summary: {                             // 结果汇总
                total: results.total,              // 总数
                success: results.successCount,     // 成功数
                failed: results.failedCount        // 失败数
            },
            successful_videos: results.success,   // 成功的视频详细信息
            failed_videos: results.failed,        // 失败的视频错误信息
            video_stats: this.getVideoStats()     // 当前所有视频的统计信息
        };

        // 将数据写入JSON文件，使用2个空格的缩进格式化
        await fs.writeFile(filename, JSON.stringify(exportData, null, 2), 'utf8');
        console.log(`📄 结果已导出到: ${filename}`);
        
        return filename;
    }

    /**
     * 工具函数：异步睡眠
     * 用于在异步操作中添加延迟，避免请求过于频繁
     * @param {number} ms - 睡眠时间（毫秒）
     * @returns {Promise} 返回在指定时间后解决的Promise
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 关闭MCP服务器
     * 清理资源，终止MCP服务器进程
     * 应在程序结束时调用，确保资源正确释放
     */
    async close() {
        if (this.mcpProcess) {
            this.mcpProcess.kill();    // 终止MCP服务器进程
            this.mcpProcess = null;    // 清空进程引用
        }
    }
}

/**
 * 使用示例主函数
 * 演示如何使用DuomiVideoGenerator进行批量视频生成
 */
async function main() {
    // 创建视频生成器实例
    const generator = new DuomiVideoGenerator();

    try {
        // 第一步：启动MCP服务器
        // MCP服务器是与Duomi API通信的桥梁
        await generator.startMCPServer();
        console.log('✅ MCP服务器启动成功');

        // 第二步：定义要生成的视频提示词
        // 支持两种格式：字符串或包含title和prompt的对象
        const prompts = [
            {
                title: "老人与海",  // 视频标题，用于识别和管理
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

        // 第三步：执行批量视频生成
        // 配置批量处理参数以优化性能和避免API限制
        const results = await generator.batchGenerateVideos(prompts, {
            maxConcurrent: 2,               // 最大并发数：同时处理2个视频
            delayBetweenRequests: 3000,     // 请求间隔：每个请求间隔3秒
            maxAttempts: 60                 // 最大轮询次数：每个视频最多等待30分钟
        });

        // 第四步：显示处理结果汇总
        console.log('\n📊 批量生成完成！');
        console.log(`✅ 成功: ${results.successCount}/${results.total}`);
        console.log(`❌ 失败: ${results.failedCount}/${results.total}`);

        // 第五步：显示成功生成的视频详情
        if (results.success.length > 0) {
            console.log('\n🎬 成功生成的视频:');
            results.success.forEach((video, index) => {
                console.log(`${index + 1}. ${video.title || video.prompt.substring(0, 50)}`);
                console.log(`   📹 视频链接: ${video.videoUrl}`);
                console.log(`   🆔 任务ID: ${video.taskId}`);
            });
        }

        // 第六步：显示生成失败的视频及错误原因
        if (results.failed.length > 0) {
            console.log('\n❌ 生成失败的视频:');
            results.failed.forEach((failure, index) => {
                console.log(`${index + 1}. ${failure.title || failure.prompt.substring(0, 50)}`);
                console.log(`   💥 错误原因: ${failure.error}`);
            });
        }

        // 第七步：导出结果到JSON文件
        // 生成包含详细信息的报告文件，便于后续分析和存档
        await generator.exportResults(results);

    } catch (error) {
        // 捕获并处理程序执行过程中的任何错误
        console.error('❌ 程序执行失败:', error.message);
    } finally {
        // 确保资源清理：无论成功或失败都要关闭MCP服务器
        await generator.close();
        console.log('\n🔚 程序结束');
    }
}

// 程序入口点：当直接运行此文件时执行main函数
if (require.main === module) {
    main().catch(console.error);  // 捕获并打印任何未处理的错误
}

// 导出DuomiVideoGenerator类，供其他模块使用
module.exports = DuomiVideoGenerator;
