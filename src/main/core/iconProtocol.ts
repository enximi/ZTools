import { protocol } from 'electron'
import { IconExtractor } from './native/index'

/** 图标内存缓存（LRU 淘汰，Map 按插入顺序迭代） */
const iconMemoryCache = new Map<string, Buffer>()
const MAX_ICON_CACHE = 128

/**
 * 写入图标缓存（LRU 淘汰）
 * 命中时先 delete 再 set，保证该 key 移到 Map 末尾（最近使用）
 */
function setIconCache(key: string, buffer: Buffer): void {
  // 已存在则先删除，重新插入以刷新顺序
  if (iconMemoryCache.has(key)) {
    iconMemoryCache.delete(key)
  } else if (iconMemoryCache.size >= MAX_ICON_CACHE) {
    // 淘汰最早插入（最久未使用）的条目
    const oldest = iconMemoryCache.keys().next().value
    if (oldest !== undefined) {
      iconMemoryCache.delete(oldest)
    }
  }
  iconMemoryCache.set(key, buffer)
}

/**
 * 根据平台提取图标并返回 PNG Buffer（异步）
 */
async function extractIcon(iconPath: string): Promise<Buffer> {
  const iconBuffer = await IconExtractor.getFileIcon(iconPath)
  if (!iconBuffer) {
    throw new Error('Failed to extract icon')
  }
  return iconBuffer
}

/**
 * 创建图标 Response
 */
function createIconResponse(buffer: Buffer): Response {
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'content-type': 'image/png',
      'content-length': buffer.length.toString(),
      'access-control-allow-origin': '*'
    }
  })
}

/**
 * 注册 ztools-icon:// 为特权协议
 * 必须在 app.ready 之前调用
 */
export function registerIconScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'ztools-icon',
      privileges: {
        bypassCSP: true,
        secure: true,
        standard: false,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: false
      }
    }
  ])
}

/**
 * 获取文件图标的 base64 Data URL（异步）
 * 支持文件路径或文件扩展名（如 ".txt"）
 */
export async function getFileIconAsBase64(filePath: string): Promise<string> {
  // 命中内存缓存（刷新 LRU 顺序）
  const cached = iconMemoryCache.get(filePath)
  if (cached) {
    setIconCache(filePath, cached)
    return `data:image/png;base64,${cached.toString('base64')}`
  }

  const buffer = await extractIcon(filePath)

  // 写入内存缓存
  setIconCache(filePath, buffer)

  return `data:image/png;base64,${buffer.toString('base64')}`
}

/**
 * 在指定 session 中注册 ztools-icon:// 协议 handler
 * 供内置插件使用（外部插件不需要访问应用图标）
 */
export function registerIconProtocolForSession(targetSession: Electron.Session): void {
  if (targetSession.protocol.isProtocolHandled('ztools-icon')) {
    return
  }

  targetSession.protocol.handle('ztools-icon', async (request) => {
    try {
      const urlPath = request.url.replace('ztools-icon://', '')
      const iconPath = decodeURIComponent(urlPath)

      // 命中内存缓存：刷新 LRU 并返回
      const cached = iconMemoryCache.get(iconPath)
      if (cached) {
        setIconCache(iconPath, cached)
        return createIconResponse(cached)
      }

      // 未命中：提取图标
      const buffer = await extractIcon(iconPath)

      // 写入内存缓存
      setIconCache(iconPath, buffer)

      return createIconResponse(buffer)
    } catch (error) {
      console.error('[Main] 图标提取失败:', error)
      return new Response('Icon Error', { status: 404 })
    }
  })
}
