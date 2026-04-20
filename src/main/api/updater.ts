import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { is } from '@electron-toolkit/utils'
import { promises as fs } from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import { spawn } from 'child_process'
import yaml from 'yaml'
import { autoUpdater, type AppUpdater } from 'electron-updater'
import { downloadFile } from '../utils/download.js'
import databaseAPI from './shared/database.js'
import { applyWindowMaterial, getDefaultWindowMaterial } from '../utils/windowUtils.js'

interface UpdatePaths {
  updaterPath: string
  asarSrc: string
  asarDst: string
  unpackedSrc: string
  unpackedDst: string
  appPath: string
}

interface NormalizedUpdateInfo {
  version: string
  changelog: string
  releaseNotes: string
  downloadUrl?: string
}

interface UpdateCheckResponse {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  updateInfo?: NormalizedUpdateInfo
  error?: string
}

export class UpdaterAPI {
  private readonly macLatestYmlUrl =
    'https://github.com/ZToolsCenter/ZTools/releases/latest/download/latest.yml'

  private mainWindow: BrowserWindow | null = null
  private checkTimer: NodeJS.Timeout | null = null
  private downloadedUpdateInfo: NormalizedUpdateInfo | null = null
  private downloadedUpdatePath: string | null = null
  private updateWindow: BrowserWindow | null = null

  private windowsUpdater: AppUpdater | null = null
  private windowsDownloadInProgress = false
  private windowsInstallAfterDownload = false
  private availableWindowsUpdateInfo: NormalizedUpdateInfo | null = null

  public init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    this.setupPlatformUpdater()
    this.setupIPC()
    this.startAutoCheck()
  }

  private setupPlatformUpdater(): void {
    if (process.platform !== 'win32' || !app.isPackaged) {
      return
    }

    this.windowsUpdater = autoUpdater
    this.windowsUpdater.autoDownload = false
    this.windowsUpdater.autoInstallOnAppQuit = false

    this.windowsUpdater.on('update-available', (info: any) => {
      const normalized = this.normalizeUpdateInfo(info)
      this.availableWindowsUpdateInfo = normalized
      console.log('[Updater] Windows 发现新版本:', normalized.version)
    })

    this.windowsUpdater.on('update-not-available', () => {
      console.log('[Updater] Windows 当前已是最新版本')
    })

    this.windowsUpdater.on('update-downloaded', (info: any) => {
      const normalized = this.normalizeUpdateInfo(info)
      this.availableWindowsUpdateInfo = normalized
      this.downloadedUpdateInfo = normalized
      this.downloadedUpdatePath = null
      this.windowsDownloadInProgress = false

      this.mainWindow?.webContents.send('update-downloaded', {
        version: normalized.version,
        changelog: normalized.changelog
      })

      console.log('[Updater] Windows 更新下载完成，等待安装')

      if (this.windowsInstallAfterDownload) {
        this.windowsInstallAfterDownload = false
        setTimeout(() => {
          void this.installDownloadedUpdate()
        }, 300)
        return
      }

      this.createUpdateWindow()
    })

    this.windowsUpdater.on('error', (error: Error) => {
      const wasDownloading = this.windowsDownloadInProgress || this.windowsInstallAfterDownload
      this.windowsDownloadInProgress = false
      this.windowsInstallAfterDownload = false

      console.error('[Updater] Windows 更新失败:', error)

      if (wasDownloading) {
        this.mainWindow?.webContents.send('update-download-failed', {
          error: error.message || '下载失败'
        })
      }
    })
  }

  private setupIPC(): void {
    ipcMain.handle('updater:check-update', () => this.checkUpdate())
    ipcMain.handle('updater:start-update', (_event, updateInfo) => this.startUpdate(updateInfo))
    ipcMain.handle('updater:install-downloaded-update', () => this.installDownloadedUpdate())
    ipcMain.handle('updater:get-download-status', () => this.getDownloadStatus())

    ipcMain.on('updater:quit-and-install', () => {
      void this.installDownloadedUpdate()
    })
    ipcMain.on('updater:close-window', () => this.closeUpdateWindow())
    ipcMain.on('updater:window-ready', () => {
      if (this.updateWindow && this.downloadedUpdateInfo) {
        this.updateWindow.webContents.send('update-info', {
          version: this.downloadedUpdateInfo.version,
          changelog: this.downloadedUpdateInfo.changelog
        })
      }
    })
  }

  private normalizeReleaseNotes(value: unknown): string {
    if (typeof value === 'string') {
      return value
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => {
          if (typeof item === 'string') {
            return item
          }

          if (item && typeof item === 'object' && 'note' in item && typeof item.note === 'string') {
            return item.note
          }

          return ''
        })
        .filter(Boolean)
        .join('\n\n')
    }

    return ''
  }

  private normalizeUpdateInfo(updateInfo: {
    version?: unknown
    releaseNotes?: unknown
    changelog?: unknown
    downloadUrl?: unknown
  }): NormalizedUpdateInfo {
    const version =
      typeof updateInfo.version === 'string' && updateInfo.version
        ? updateInfo.version
        : app.getVersion()
    const releaseNotes = this.normalizeReleaseNotes(updateInfo.releaseNotes ?? updateInfo.changelog)

    return {
      version,
      changelog: releaseNotes,
      releaseNotes,
      downloadUrl: typeof updateInfo.downloadUrl === 'string' ? updateInfo.downloadUrl : undefined
    }
  }

  private isWindowsUpdaterAvailable(): boolean {
    return process.platform === 'win32' && app.isPackaged && this.windowsUpdater !== null
  }

  private getDownloadStatus(): { hasDownloaded: boolean; version?: string; changelog?: string } {
    if (!this.downloadedUpdateInfo) {
      return { hasDownloaded: false }
    }

    return {
      hasDownloaded: true,
      version: this.downloadedUpdateInfo.version,
      changelog: this.downloadedUpdateInfo.changelog
    }
  }

  /**
   * 启动自动检查（30分钟一次）
   */
  private startAutoCheck(): void {
    try {
      const settings = databaseAPI.dbGet('settings-general')
      const autoCheck = settings?.autoCheckUpdate ?? true

      if (!autoCheck) {
        console.log('[Updater] 自动检查更新已禁用')
        return
      }

      this.autoCheckAndDownload()
      this.cleanup()
      this.checkTimer = setInterval(() => this.autoCheckAndDownload(), 30 * 60 * 1000)
    } catch (error) {
      console.error('[Updater] 启动自动检查更新失败:', error)
      this.autoCheckAndDownload()
      this.checkTimer = setInterval(() => this.autoCheckAndDownload(), 30 * 60 * 1000)
    }
  }

  private stopAutoCheck(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
      console.log('[Updater] 自动检查更新已停止')
    }
  }

  public setAutoCheck(enabled: boolean): void {
    if (enabled) {
      this.startAutoCheck()
    } else {
      this.stopAutoCheck()
    }
  }

  private async autoCheckAndDownload(): Promise<void> {
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      return
    }

    try {
      console.log('[Updater] 开始自动检查更新...')

      if (this.downloadedUpdateInfo) {
        console.log('[Updater] 已有下载的更新，跳过检查')
        return
      }

      if (process.platform === 'win32') {
        const result = await this.checkWindowsUpdate()
        if (result.hasUpdate) {
          console.log('[Updater] Windows 发现新版本，开始自动下载...', result.updateInfo)
          await this.downloadWindowsUpdate(false)
        }
        return
      }

      const result = await this.checkMacUpdate()
      if (result.hasUpdate && result.updateInfo) {
        console.log('[Updater] 发现新版本，开始自动下载...', result.updateInfo)

        this.mainWindow?.webContents.send('update-download-start', {
          version: result.updateInfo.version
        })

        const downloadResult = await this.downloadAndExtractMacUpdate(result.updateInfo)
        if (downloadResult.success) {
          this.downloadedUpdateInfo = result.updateInfo
          this.downloadedUpdatePath = downloadResult.extractPath || null

          this.mainWindow?.webContents.send('update-downloaded', {
            version: result.updateInfo.version,
            changelog: result.updateInfo.changelog
          })

          console.log('[Updater] 更新下载完成，等待用户安装')
          this.createUpdateWindow()
        } else {
          console.error('[Updater] 更新下载失败:', downloadResult.error)
          this.mainWindow?.webContents.send('update-download-failed', {
            error: downloadResult.error || '下载失败'
          })
        }
      }
    } catch (error) {
      console.error('[Updater] 自动检查更新失败:', error)
    }
  }

  private async checkWindowsUpdate(): Promise<UpdateCheckResponse> {
    const currentVersion = app.getVersion()

    if (this.downloadedUpdateInfo) {
      return {
        hasUpdate: true,
        currentVersion,
        latestVersion: this.downloadedUpdateInfo.version,
        updateInfo: this.downloadedUpdateInfo
      }
    }

    if (!this.isWindowsUpdaterAvailable()) {
      return {
        hasUpdate: false,
        currentVersion,
        error: 'Windows 自动更新仅支持打包后的应用'
      }
    }

    try {
      console.log('[Updater] 开始检查 Windows 更新...')
      const result = await this.windowsUpdater!.checkForUpdates()
      const nextInfo = result?.updateInfo

      if (!nextInfo?.version) {
        return { hasUpdate: false, currentVersion, latestVersion: currentVersion }
      }

      const latestVersion = nextInfo.version
      if (this.compareVersions(latestVersion, currentVersion) <= 0) {
        return { hasUpdate: false, currentVersion, latestVersion }
      }

      const updateInfo = this.normalizeUpdateInfo(nextInfo)
      this.availableWindowsUpdateInfo = updateInfo

      return {
        hasUpdate: true,
        currentVersion,
        latestVersion,
        updateInfo
      }
    } catch (error: unknown) {
      console.error('[Updater] 检查 Windows 更新失败:', error)
      return {
        hasUpdate: false,
        currentVersion,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  private async downloadWindowsUpdate(
    installAfterDownload: boolean
  ): Promise<{ success: boolean; error?: string }> {
    if (this.downloadedUpdateInfo) {
      if (installAfterDownload) {
        return this.installDownloadedUpdate()
      }
      return { success: true }
    }

    if (!this.isWindowsUpdaterAvailable()) {
      return { success: false, error: 'Windows 自动更新仅支持打包后的应用' }
    }

    if (this.windowsDownloadInProgress) {
      return { success: false, error: '更新正在下载中' }
    }

    const updateInfo =
      this.availableWindowsUpdateInfo ?? (await this.checkWindowsUpdate()).updateInfo
    if (!updateInfo) {
      return { success: false, error: '没有可用的更新' }
    }

    this.availableWindowsUpdateInfo = updateInfo
    this.windowsDownloadInProgress = true
    this.windowsInstallAfterDownload = installAfterDownload

    this.mainWindow?.webContents.send('update-download-start', {
      version: updateInfo.version
    })

    try {
      await this.windowsUpdater!.downloadUpdate()
      return { success: true }
    } catch (error: unknown) {
      this.windowsDownloadInProgress = false
      this.windowsInstallAfterDownload = false
      return {
        success: false,
        error: error instanceof Error ? error.message : '下载失败'
      }
    }
  }

  private buildMacUpdateDownloadUrl(version: string): string {
    const platform = process.platform
    const arch = process.arch
    const fileName = `update-${platform}-${arch}-${version}.zip`
    const baseUrl = 'https://github.com/ZToolsCenter/ZTools/releases/latest/download'
    return `${baseUrl}/${fileName}`
  }

  private async downloadAndExtractMacUpdate(
    updateInfo: NormalizedUpdateInfo
  ): Promise<{ success: boolean; extractPath?: string; error?: string }> {
    try {
      if (!updateInfo.downloadUrl) {
        throw new Error('缺少更新包下载地址')
      }

      console.log('[Updater] 下载更新包:', updateInfo.downloadUrl)

      const tempDir = path.join(app.getPath('userData'), 'ztools-update-pkg')
      await fs.mkdir(tempDir, { recursive: true })
      const tempZipPath = path.join(tempDir, `update-${Date.now()}.zip`)
      const extractPath = path.join(tempDir, `extracted-${Date.now()}`)

      await downloadFile(updateInfo.downloadUrl, tempZipPath)

      console.log('[Updater] 解压更新包...')
      await fs.mkdir(extractPath, { recursive: true })

      const zip = new AdmZip(tempZipPath)
      await new Promise<void>((resolve, reject) => {
        zip.extractAllToAsync(extractPath, true, false, (error?: Error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })

      const appAsarTmp = path.join(extractPath, 'app.asar.tmp')
      const appAsar = path.join(extractPath, 'app.asar')
      try {
        await fs.access(appAsarTmp)
        await fs.rename(appAsarTmp, appAsar)
        console.log('[Updater] 成功重命名: app.asar.tmp -> app.asar')
      } catch {
        console.log('[Updater] 未找到 app.asar.tmp，可能直接是 app.asar')
      }

      try {
        await fs.unlink(tempZipPath)
      } catch (error) {
        console.error('[Updater] 删除 zip 文件失败:', error)
      }

      return { success: true, extractPath }
    } catch (error: unknown) {
      console.error('[Updater] 下载更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }

  private async getMacUpdatePaths(extractPath: string): Promise<UpdatePaths> {
    const appPath = process.execPath
    const asarSrc = path.join(extractPath, 'app.asar')
    const unpackedSrc = path.join(extractPath, 'app.asar.unpacked')
    const contentsDir = path.dirname(path.dirname(appPath))
    const resourcesDir = path.join(contentsDir, 'Resources')

    const updaterPath = app.isPackaged
      ? path.join(path.dirname(appPath), 'ztools-updater')
      : path.join(
          app.getAppPath(),
          `updater/mac-${process.arch === 'arm64' ? 'arm64' : 'amd64'}/ztools-updater`
        )

    return {
      updaterPath,
      asarSrc,
      asarDst: path.join(resourcesDir, 'app.asar'),
      unpackedSrc,
      unpackedDst: path.join(resourcesDir, 'app.asar.unpacked'),
      appPath
    }
  }

  private async launchMacUpdater(paths: UpdatePaths): Promise<void> {
    try {
      await fs.access(paths.updaterPath)
    } catch {
      throw new Error(`找不到升级程序: ${paths.updaterPath}`)
    }

    const args = ['--asar-src', paths.asarSrc, '--asar-dst', paths.asarDst, '--app', paths.appPath]

    if (paths.unpackedSrc) {
      args.push('--unpacked-src', paths.unpackedSrc)
      args.push('--unpacked-dst', paths.unpackedDst)
    }

    console.log('[Updater] 启动升级程序:', paths.updaterPath, args)

    const subprocess = spawn(paths.updaterPath, args, {
      detached: true,
      stdio: 'ignore'
    })

    subprocess.unref()

    console.log('[Updater] 应用即将退出进行更新...')
    app.exit(0)
  }

  private async checkMacUpdate(): Promise<UpdateCheckResponse> {
    try {
      console.log('[Updater] 开始检查更新...')

      const tempDir = path.join(app.getPath('userData'), 'ztools-update-check')
      await fs.mkdir(tempDir, { recursive: true })
      const tempFilePath = path.join(tempDir, `latest-${Date.now()}.yml`)

      try {
        console.log('[Updater] 下载 latest.yml:', this.macLatestYmlUrl)
        await downloadFile(this.macLatestYmlUrl, tempFilePath)

        const content = await fs.readFile(tempFilePath, 'utf-8')
        const updateInfo = yaml.parse(content)

        if (!updateInfo.version) {
          throw new Error('latest.yml 格式错误：缺少 version 字段')
        }

        const latestVersion = updateInfo.version
        const currentVersion = app.getVersion()

        console.log(`当前版本: ${currentVersion}, 最新版本: ${latestVersion}`)

        if (this.compareVersions(latestVersion, currentVersion) <= 0) {
          console.log('[Updater] 当前已是最新版本')
          return { hasUpdate: false, latestVersion, currentVersion }
        }

        console.log(`发现新版本: ${latestVersion}`)

        const normalized = this.normalizeUpdateInfo({
          version: latestVersion,
          changelog: updateInfo.changelog || '',
          downloadUrl: this.buildMacUpdateDownloadUrl(latestVersion)
        })

        return {
          hasUpdate: true,
          currentVersion,
          latestVersion,
          updateInfo: normalized
        }
      } finally {
        try {
          await fs.rm(tempDir, { recursive: true, force: true })
        } catch (error) {
          console.error('[Updater] 清理临时文件失败:', error)
        }
      }
    } catch (error: unknown) {
      console.error('[Updater] 检查更新失败:', error)
      return {
        hasUpdate: false,
        error: error instanceof Error ? error.message : '检查更新失败'
      }
    }
  }

  private async startMacUpdate(
    updateInfo: NormalizedUpdateInfo
  ): Promise<{ success: boolean; error?: string }> {
    try {
      console.log('[Updater] 开始更新流程...', updateInfo)

      const downloadResult = await this.downloadAndExtractMacUpdate(updateInfo)
      if (!downloadResult.success || !downloadResult.extractPath) {
        return { success: false, error: downloadResult.error || '下载失败' }
      }

      const paths = await this.getMacUpdatePaths(downloadResult.extractPath)
      await this.launchMacUpdater(paths)

      return { success: true }
    } catch (error: unknown) {
      console.error('[Updater] 更新流程失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }

  public cleanup(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
  }

  public async checkUpdate(): Promise<UpdateCheckResponse> {
    if (process.platform === 'win32') {
      return this.checkWindowsUpdate()
    }

    if (process.platform === 'darwin') {
      return this.checkMacUpdate()
    }

    return {
      hasUpdate: false,
      error: '当前平台暂不支持自动更新'
    }
  }

  public async startUpdate(updateInfo: any): Promise<{ success: boolean; error?: string }> {
    if (process.platform === 'win32') {
      return this.downloadWindowsUpdate(true)
    }

    if (process.platform !== 'darwin') {
      return { success: false, error: '当前平台暂不支持自动更新' }
    }

    const normalized = this.normalizeUpdateInfo(updateInfo)
    if (!normalized.downloadUrl) {
      const latestVersion = normalized.version
      normalized.downloadUrl = this.buildMacUpdateDownloadUrl(latestVersion)
    }

    return this.startMacUpdate(normalized)
  }

  private applyMaterialToUpdateWindow(win: BrowserWindow): void {
    try {
      const settings = databaseAPI.dbGet('settings-general')
      const material = settings?.windowMaterial || getDefaultWindowMaterial()
      applyWindowMaterial(win, material)
    } catch (error) {
      console.error('[Updater] 应用窗口材质失败:', error)
    }
  }

  private createUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.show()
      this.updateWindow.focus()
      return
    }

    const width = 500
    const height = 450
    const primaryDisplay = screen.getPrimaryDisplay()
    const { workArea } = primaryDisplay
    const x = Math.round(workArea.x + (workArea.width - width) / 2)
    const y = Math.round(workArea.y + (workArea.height - height) / 2)

    const windowConfig: Electron.BrowserWindowConstructorOptions = {
      width,
      height,
      x,
      y,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      alwaysOnTop: true,
      hasShadow: true,
      type: 'panel',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    }

    if (process.platform === 'darwin') {
      windowConfig.transparent = true
      windowConfig.vibrancy = 'fullscreen-ui'
    } else if (process.platform === 'win32') {
      windowConfig.backgroundColor = '#00000000'
    }

    this.updateWindow = new BrowserWindow(windowConfig)

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      this.updateWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/updater.html`)
    } else {
      this.updateWindow.loadFile(path.join(__dirname, '../renderer/updater.html'))
    }

    if (process.platform === 'win32') {
      this.applyMaterialToUpdateWindow(this.updateWindow)
    }

    this.updateWindow.once('ready-to-show', () => {
      this.updateWindow?.show()
    })

    this.updateWindow.on('closed', () => {
      this.updateWindow = null
    })
  }

  private closeUpdateWindow(): void {
    if (this.updateWindow && !this.updateWindow.isDestroyed()) {
      this.updateWindow.close()
    }
  }

  private compareVersions(v1: string, v2: string): number {
    const parts1 = v1.split('.').map(Number)
    const parts2 = v2.split('.').map(Number)

    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
      const p1 = parts1[i] || 0
      const p2 = parts2[i] || 0
      if (p1 > p2) return 1
      if (p1 < p2) return -1
    }
    return 0
  }

  private async installDownloadedUpdate(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.downloadedUpdateInfo) {
        throw new Error('没有可用的更新')
      }

      if (process.platform === 'win32') {
        if (!this.isWindowsUpdaterAvailable()) {
          throw new Error('Windows 自动更新仅支持打包后的应用')
        }

        console.log('[Updater] Windows 即将安装更新...')
        this.closeUpdateWindow()
        this.windowsDownloadInProgress = false
        this.windowsInstallAfterDownload = false
        this.windowsUpdater!.quitAndInstall(true, true)
        return { success: true }
      }

      if (process.platform !== 'darwin') {
        throw new Error('当前平台暂不支持自动更新')
      }

      if (!this.downloadedUpdatePath) {
        throw new Error('没有可用的更新包')
      }

      const paths = await this.getMacUpdatePaths(this.downloadedUpdatePath)
      await this.launchMacUpdater(paths)

      return { success: true }
    } catch (error: unknown) {
      console.error('[Updater] 安装更新失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误'
      }
    }
  }
}

export default new UpdaterAPI()
