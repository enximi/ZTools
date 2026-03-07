import { execSync } from 'child_process'
import { app, protocol } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { IconExtractor } from './native/index'

/** 图标内存缓存 */
const iconMemoryCache = new Map<string, Buffer>()

/**
 * 根据平台提取图标并返回 PNG Buffer（同步）
 */
function extractIcon(iconPath: string): Buffer {
  if (process.platform === 'darwin') {
    const tempDir = path.join(app.getPath('temp'), 'ztools-icons')
    fs.mkdirSync(tempDir, { recursive: true })

    const hash = crypto.createHash('md5').update(iconPath).digest('hex')
    const tempPngPath = path.join(tempDir, `${hash}.png`)

    if (fs.existsSync(tempPngPath)) {
      return fs.readFileSync(tempPngPath)
    }

    try {
      execSync(
        `sips -s format png '${iconPath}' --out '${tempPngPath}' --resampleHeightWidth 64 64 2>/dev/null`
      )
      return fs.readFileSync(tempPngPath)
    } catch (error) {
      console.error('[Main] sips 转换失败:', iconPath, error)
      throw new Error('Icon conversion failed')
    }
  } else {
    const iconBuffer = IconExtractor.getFileIcon(iconPath, 32)
    if (!iconBuffer) {
      throw new Error('Failed to extract icon')
    }
    return iconBuffer
  }
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
 * 获取文件图标的 base64 Data URL（同步）
 * 支持文件路径或文件扩展名（如 ".txt"）
 */
export function getFileIconAsBase64(filePath: string): string {
  // 命中内存缓存
  const cached = iconMemoryCache.get(filePath)
  if (cached) {
    return `data:image/png;base64,${cached.toString('base64')}`
  }

  const buffer = extractIcon(filePath)

  // 写入内存缓存
  iconMemoryCache.set(filePath, buffer)

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

  targetSession.protocol.handle('ztools-icon', (request) => {
    try {
      const urlPath = request.url.replace('ztools-icon://', '')
      const iconPath = decodeURIComponent(urlPath)

      // 命中内存缓存：直接返回
      const cached = iconMemoryCache.get(iconPath)
      if (cached) {
        return createIconResponse(cached)
      }

      // 未命中：提取图标
      const buffer = extractIcon(iconPath)

      // 写入内存缓存
      iconMemoryCache.set(iconPath, buffer)

      return createIconResponse(buffer)
    } catch (error) {
      console.error('[Main] 图标提取失败:', error)
      return new Response('Icon Error', { status: 404 })
    }
  })
}
