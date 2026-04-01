import { createClient, WebDAVClient } from 'webdav'
import { SyncConfig, RemoteFileMeta, RemotePluginManifest } from './types'

/**
 * 将 docId 编码为 WebDAV 路径（保留目录结构）
 * ZTOOLS/settings-general → ZTOOLS/settings-general
 * 每段单独编码，/ 保留为路径分隔符
 */
function encodeDocPath(docId: string): string {
  return docId
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * 从 WebDAV 路径还原 docId
 */
function decodeDocPath(path: string): string {
  return path
    .split('/')
    .map((seg) => decodeURIComponent(seg))
    .join('/')
}

/**
 * WebDAV 同步客户端
 */
export class WebDAVSyncClient {
  private client: WebDAVClient | null = null
  /** 缓存已确认存在的目录路径，避免重复 PROPFIND 请求 */
  private dirExistsCache = new Set<string>()

  /**
   * 初始化 WebDAV 客户端
   */
  async init(config: SyncConfig): Promise<void> {
    this.client = createClient(config.serverUrl, {
      username: config.username,
      password: config.password
    })

    // 重置目录缓存
    this.dirExistsCache.clear()

    // 测试连接
    await this.testConnection()

    // 确保远程目录存在
    await this.ensureRemoteDirectory()
  }

  /**
   * 测试 WebDAV 连接
   */
  async testConnection(): Promise<boolean> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    try {
      await this.client.getDirectoryContents('/')
      return true
    } catch (error: any) {
      throw new Error('WebDAV 连接失败: ' + error.message)
    }
  }

  /**
   * 确保远程目录存在
   */
  private async ensureRemoteDirectory(): Promise<void> {
    if (!this.client) return

    const dirs = ['/ztools-sync', '/ztools-sync/attachments', '/ztools-sync/plugins']
    for (const dir of dirs) {
      if (!this.dirExistsCache.has(dir)) {
        const exists = await this.client.exists(dir)
        if (!exists) {
          await this.client.createDirectory(dir)
        }
        this.dirExistsCache.add(dir)
      }
    }
  }

  /**
   * 确保路径的父目录存在（递归创建，带缓存）
   */
  private async ensureParentDir(filePath: string): Promise<void> {
    if (!this.client) return
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    if (!dir || dir === '/ztools-sync' || this.dirExistsCache.has(dir)) return

    // 先递归确保上级目录存在
    await this.ensureParentDir(dir)

    try {
      await this.client.createDirectory(dir)
    } catch (error: any) {
      // 竞态条件：并发时其他请求可能已创建该目录，二次确认目录是否已存在
      const exists = await this.client.exists(dir).catch(() => false)
      if (!exists) {
        throw error
      }
    }
    this.dirExistsCache.add(dir)
  }

  /**
   * 上传文档到云端
   */
  async uploadDoc(doc: any): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留 docId 中的 / 作为目录结构，每段单独编码
    const safeDocId = encodeDocPath(doc._id)
    const remotePath = `/ztools-sync/${safeDocId}.json`
    const content = JSON.stringify(doc, null, 2)

    try {
      await this.ensureParentDir(remotePath)
      await this.client.putFileContents(remotePath, content, {
        overwrite: true
      })
    } catch (error: any) {
      console.error(`[WebDAV] 上传文档失败: ${doc._id}`, error.message)
      throw error
    }
  }

  /**
   * 从云端下载文档
   */
  async downloadDoc(docId: string): Promise<any | null> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留目录结构，每段单独编码
    const safeDocId = encodeDocPath(docId)
    const remotePath = `/ztools-sync/${safeDocId}.json`
    const exists = await this.client.exists(remotePath)
    if (!exists) return null

    const content = (await this.client.getFileContents(remotePath, {
      format: 'text'
    })) as string
    return JSON.parse(content)
  }

  /**
   * 获取云端文档列表（包含元数据，递归遍历子目录）
   */
  async listRemoteDocsWithMeta(): Promise<RemoteFileMeta[]> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const results: RemoteFileMeta[] = []
    const basePath = '/ztools-sync'
    // 排除附件和插件目录
    const excludeDirs = new Set([`${basePath}/attachments`, `${basePath}/plugins`])

    const walk = async (dirPath: string): Promise<void> => {
      const response = await this.client!.getDirectoryContents(dirPath, {
        details: true
      })
      const contents = Array.isArray(response) ? response : (response as any).data
      if (!Array.isArray(contents)) return

      for (const item of contents) {
        if (item.type === 'directory') {
          // 标准化路径：移除尾部斜杠，确保 excludeDirs 判断一致
          const filename = item.filename.replace(/\/+$/, '')
          if (!excludeDirs.has(filename)) {
            await walk(filename)
          }
        } else if (item.type === 'file' && item.filename.endsWith('.json')) {
          // 从完整路径提取 docId：去掉 basePath/ 前缀和 .json 后缀
          const relativePath = item.filename.substring(basePath.length + 1)
          const encodedDocId = relativePath.replace(/\.json$/, '')
          const docId = decodeDocPath(encodedDocId)
          results.push({
            docId,
            lastModified: new Date(item.lastmod).getTime()
          })
        }
      }
    }

    await walk(basePath)
    return results
  }

  /**
   * 删除云端文档
   */
  async deleteDoc(docId: string): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留目录结构，每段单独编码
    const safeDocId = encodeDocPath(docId)
    const remotePath = `/ztools-sync/${safeDocId}.json`
    await this.client.deleteFile(remotePath)
  }

  /**
   * 上传附件到云端
   */
  async uploadAttachment(docId: string, data: Buffer, metadata?: any): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留目录结构，每段单独编码
    const safeDocId = encodeDocPath(docId)

    // 上传二进制数据
    const dataPath = `/ztools-sync/attachments/${safeDocId}.bin`
    await this.ensureParentDir(dataPath)
    await this.client.putFileContents(dataPath, data, {
      overwrite: true
    })

    // 上传元数据（如果提供）
    if (metadata) {
      const metaPath = `/ztools-sync/attachments/${safeDocId}.meta.json`
      await this.client.putFileContents(metaPath, JSON.stringify(metadata, null, 2), {
        overwrite: true
      })
    }
  }

  /**
   * 从云端下载附件
   */
  async downloadAttachment(docId: string): Promise<{ data: Buffer; metadata?: any } | null> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留目录结构，每段单独编码
    const safeDocId = encodeDocPath(docId)
    const dataPath = `/ztools-sync/attachments/${safeDocId}.bin`
    const metaPath = `/ztools-sync/attachments/${safeDocId}.meta.json`

    // 检查二进制数据是否存在
    const dataExists = await this.client.exists(dataPath)
    if (!dataExists) return null

    // 下载二进制数据
    const data = (await this.client.getFileContents(dataPath, {
      format: 'binary'
    })) as Buffer

    // 尝试下载元数据
    let metadata: any = undefined
    try {
      const metaExists = await this.client.exists(metaPath)
      if (metaExists) {
        const metaContent = (await this.client.getFileContents(metaPath, {
          format: 'text'
        })) as string
        metadata = JSON.parse(metaContent)
      }
    } catch (error) {
      console.warn(`[WebDAV] 下载附件元数据失败: ${docId}`, error)
    }

    return { data, metadata }
  }

  /**
   * 删除云端附件
   */
  async deleteAttachment(docId: string): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    // 保留目录结构，每段单独编码
    const safeDocId = encodeDocPath(docId)
    const remotePath = `/ztools-sync/attachments/${safeDocId}.bin`
    const exists = await this.client.exists(remotePath)
    if (exists) {
      await this.client.deleteFile(remotePath)
    }
  }

  /**
   * 获取云端附件列表（递归遍历子目录）
   */
  async listRemoteAttachments(): Promise<string[]> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const results: string[] = []
    const basePath = '/ztools-sync/attachments'

    const walk = async (dirPath: string): Promise<void> => {
      const response = await this.client!.getDirectoryContents(dirPath, {
        details: true
      })
      const contents = Array.isArray(response) ? response : (response as any).data
      if (!Array.isArray(contents)) return

      for (const item of contents) {
        if (item.type === 'directory') {
          const filename = item.filename.replace(/\/+$/, '')
          await walk(filename)
        } else if (item.type === 'file' && item.filename.endsWith('.bin')) {
          const relativePath = item.filename.substring(basePath.length + 1)
          const encodedId = relativePath.replace(/\.bin$/, '')
          results.push(decodeDocPath(encodedId))
        }
      }
    }

    await walk(basePath)
    return results
  }

  // ==================== 插件同步相关方法 ====================

  /**
   * 上传插件 zip 到云端
   */
  async uploadPluginZip(pluginName: string, zipBuffer: Buffer): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const encoded = encodeURIComponent(pluginName)
    const remotePath = `/ztools-sync/plugins/${encoded}.zip`

    try {
      await this.client.putFileContents(remotePath, zipBuffer, {
        overwrite: true
      })
    } catch (error: any) {
      console.error(`[WebDAV] 上传插件 zip 失败: ${pluginName}`, error.message)
      throw error
    }
  }

  /**
   * 从云端下载插件 zip
   */
  async downloadPluginZip(pluginName: string): Promise<Buffer | null> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const encoded = encodeURIComponent(pluginName)
    const remotePath = `/ztools-sync/plugins/${encoded}.zip`
    const exists = await this.client.exists(remotePath)
    if (!exists) return null

    const data = (await this.client.getFileContents(remotePath, {
      format: 'binary'
    })) as Buffer

    return Buffer.from(data)
  }

  /**
   * 删除云端插件 zip
   */
  async deletePluginZip(pluginName: string): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const encoded = encodeURIComponent(pluginName)
    const remotePath = `/ztools-sync/plugins/${encoded}.zip`
    const exists = await this.client.exists(remotePath)
    if (exists) {
      await this.client.deleteFile(remotePath)
    }
  }

  /**
   * 上传插件清单到云端
   */
  async uploadPluginManifest(manifest: RemotePluginManifest): Promise<void> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const remotePath = '/ztools-sync/plugins/manifest.json'
    const content = JSON.stringify(manifest, null, 2)

    await this.client.putFileContents(remotePath, content, {
      overwrite: true
    })
  }

  /**
   * 从云端下载插件清单
   */
  async downloadPluginManifest(): Promise<RemotePluginManifest> {
    if (!this.client) {
      throw new Error('WebDAV 客户端未初始化')
    }

    const remotePath = '/ztools-sync/plugins/manifest.json'
    const exists = await this.client.exists(remotePath)
    if (!exists) return {}

    try {
      const content = (await this.client.getFileContents(remotePath, {
        format: 'text'
      })) as string
      return JSON.parse(content)
    } catch (error) {
      console.warn('[WebDAV] 解析插件清单失败:', error)
      return {}
    }
  }
}
