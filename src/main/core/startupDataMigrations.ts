import databaseAPI from '../api/shared/database.js'

/**
 * 将单个旧版 macOS .icns 图标 URL 迁移为直接使用 .app 路径的 ztools-icon URL
 */
function migrateLegacyMacAppIcon(item: { path?: string; icon?: string }): boolean {
  if (process.platform !== 'darwin') return false
  if (!item || typeof item.path !== 'string' || typeof item.icon !== 'string') return false
  if (!item.path.endsWith('.app') || !item.icon.startsWith('ztools-icon://')) return false

  const encodedPath = item.icon.replace('ztools-icon://', '')
  let decodedPath = ''
  try {
    decodedPath = decodeURIComponent(encodedPath)
  } catch {
    return false
  }

  if (!decodedPath.endsWith('.icns')) return false

  const nextIcon = `ztools-icon://${encodeURIComponent(item.path)}`
  if (item.icon === nextIcon) return false

  item.icon = nextIcon
  return true
}

/**
 * 递归迁移数组中的旧版 macOS 应用图标 URL
 */
function migrateLegacyMacAppIcons(items: any[]): boolean {
  if (process.platform !== 'darwin' || !Array.isArray(items)) return false

  let changed = false

  for (const item of items) {
    if (!item || typeof item !== 'object') continue

    if (migrateLegacyMacAppIcon(item)) {
      changed = true
    }

    if (Array.isArray(item.items) && migrateLegacyMacAppIcons(item.items)) {
      changed = true
    }
  }

  return changed
}

/**
 * 启动时统一迁移历史遗留数据
 * 当前仅处理旧版 macOS .icns 图标 URL 到 .app 路径图标 URL 的转换
 */
export function runStartupDataMigrations(): void {
  if (process.platform !== 'darwin') return

  const migrationKeys = [
    'command-history',
    'pinned-commands',
    'cached-commands',
    'local-shortcuts',
    'super-panel-pinned'
  ]

  for (const key of migrationKeys) {
    try {
      const data = databaseAPI.dbGet(key)
      if (!Array.isArray(data)) continue

      if (migrateLegacyMacAppIcons(data)) {
        databaseAPI.dbPut(key, data)
        console.log(`[StartupMigration] 已迁移旧版 macOS 图标数据: ${key}`)
      }
    } catch (error) {
      console.error(`[StartupMigration] 迁移失败: ${key}`, error)
    }
  }
}
